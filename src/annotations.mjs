import { createHash } from 'node:crypto';
import { readObservation } from './contracts.mjs';
import { request, snapshot, sameOccupant } from './herdr.mjs';
import { workerStatus } from './status.mjs';
import { checkWorkerHandoff } from './ownership.mjs';

const paneTokens = (label, kind) => ({ pi_continuation: label,
  pi_continuation_active: kind === 'active' ? label : null,
  pi_continuation_attention: ['held', 'unavailable'].includes(kind) ? label : null,
  pi_continuation_paused: kind === 'paused' ? label : null });

/** One display reporter owned by the existing supervisor, not a scheduler or
 * policy owner. Failures leave authoritative supervision state untouched. */
export function createAnnotations({ root, socketPath, ownerToken, ownerBinding, readState, onError,
  transport = request, readSnapshot = snapshot, now = Date.now, refreshMs = 5000, ttlMs = 15000 }) {
  const source = 'pi-continuation:' + createHash('sha256').update(ownerToken).digest('hex').slice(0, 16);
  const sent = new Map();
  let sequence = 0, failures = 0, closed = false, dirty = false, refreshing = false, failed = false;
  let pending = Promise.resolve(), closing;
  const current = () => {
    const value = readState();
    // Missing native owner evidence disables display, not supervision authority.
    return ownerBinding && value?.ownerToken === ownerToken &&
      value.supervisorSession === ownerBinding.sessionId ? value : undefined;
  };
  const ownerMatches = live => !!ownerBinding &&
    sameOccupant(live.agents.find(a => a.pane_id === ownerBinding.paneId), ownerBinding);
  const report = error => { failures++; if (!failed) { failed = true; onError(error); } };
  const send = async entry => {
    const result = await transport(socketPath, `${entry.kind}.report_metadata`, {
      [`${entry.kind}_id`]: entry.id, source, seq: ++sequence, ttl_ms: ttlMs,
      ...(entry.kind === 'pane' ? { applies_to_source: 'herdr:pi' } : {}), tokens: entry.tokens });
    if (result?.type !== 'ok') throw new Error('Unexpected Herdr metadata acknowledgement');
  };
  const clear = async (key, entry) => {
    try { await send({ ...entry, tokens: Object.fromEntries(Object.keys(entry.tokens).map(k => [k, null])) }); }
    catch (error) {
      // A deleted target has no tokens left to clear. Other failures stay visible;
      // TTL remains the fallback for an unreachable target that may still exist.
      if (error.code !== `${entry.kind}_not_found`) report(error);
    }
    sent.delete(key);
  };
  const clearAll = () => Promise.all([...sent].map(([key, entry]) => clear(key, entry)));
  const project = async (state, live) => {
    const desired = new Map(), groups = new Map();
    for (const binding of Object.values(state.workers)) {
      const agent = live.agents.find(a => a.pane_id === binding.paneId);
      if (binding.stopped || !sameOccupant(agent, binding)) continue;
      try { await checkWorkerHandoff(root, binding.workerId, binding); }
      catch (error) { report(error); continue; }
      let observation;
      try { observation = await readObservation(root, binding.workerId); }
      catch (error) { if (error.code !== 'ENOENT') report(error); }
      const status = workerStatus(state, binding, agent, observation);
      desired.set(`pane:${binding.paneId}`, { kind: 'pane', id: binding.paneId, binding,
        identity: JSON.stringify(binding), tokens: paneTokens(status.label, status.kind) });
      const group = groups.get(binding.workspaceId) ?? [];
      group.push(status);
      groups.set(binding.workspaceId, group);
    }
    if (ownerBinding?.sessionId === state.supervisorSession &&
        sameOccupant(live.agents.find(a => a.pane_id === ownerBinding.paneId), ownerBinding)) {
      const kind = state.paused ? 'paused' : 'active';
      desired.set(`pane:${ownerBinding.paneId}`, { kind: 'pane', id: ownerBinding.paneId, binding: ownerBinding,
        identity: JSON.stringify(ownerBinding), tokens: paneTokens(state.paused ? 'Supervisor: paused' : 'Supervisor', kind) });
    }
    for (const [id, statuses] of groups) {
      if (!live.workspaces?.some(w => w.workspace_id === id)) continue;
      const held = statuses.filter(s => s.kind === 'held').length;
      const paused = statuses.filter(s => s.kind === 'paused').length;
      const unknown = statuses.filter(s => s.kind === 'unavailable').length;
      const suffix = held ? `${held} held` : paused ? `${paused} paused` : unknown ? `${unknown} unknown` : '';
      desired.set(`workspace:${id}`, { kind: 'workspace', id, identity: id,
        tokens: { pi_continuation_summary: `${statuses.length} worker${statuses.length === 1 ? '' : 's'}${suffix ? ' · ' + suffix : ''}` } });
    }
    return desired;
  };
  const publish = async () => {
    const initialFailures = failures;
    if (!current()) { await clearAll(); return; }
    const live = await readSnapshot(socketPath);
    const state = current();
    if (closed) return;
    if (!state || !ownerMatches(live)) {
      await clearAll(); return;
    }
    const revision = JSON.stringify(state);
    const stable = () => {
      const latest = current();
      if (!latest) { dirty = true; return false; }
      if (JSON.stringify(latest) === revision) return true;
      dirty = true;
      return false;
    };
    const desired = await project(state, live);
    if (closed || !stable()) return;
    for (const [key, entry] of sent) if (!desired.has(key)) await clear(key, entry);
    for (const [key, entry] of desired) {
      if (closed || !stable()) return;
      // Metadata events can invalidate the shared snapshot too. Avoid publishing
      // our own unchanged report again until its bounded TTL renewal is due.
      const prior = sent.get(key);
      if (prior && prior.identity === entry.identity && JSON.stringify(prior.tokens) === JSON.stringify(entry.tokens) &&
          now() - prior.at < refreshMs) continue;
      const verified = await readSnapshot(socketPath);
      if (closed || !stable()) return;
      if (!ownerMatches(verified)) { await clearAll(); return; }
      const bindings = entry.kind === 'pane' ? [entry.binding] : [...desired.values()]
        .filter(e => e.binding?.workerId && e.binding.workspaceId === entry.id).map(e => e.binding);
      const stale = bindings.filter(binding => !sameOccupant(verified.agents.find(a => a.pane_id === binding.paneId), binding));
      if (stale.length) {
        for (const binding of stale) {
          for (const key of [`pane:${binding.paneId}`, `workspace:${binding.workspaceId}`]) {
            const prior = sent.get(key);
            if (prior) await clear(key, prior);
          }
        }
        return; // A fresh event or the TTL renewal will reconcile, not a hot retry.
      }
      if (entry.kind === 'workspace' && !verified.workspaces?.some(w => w.workspace_id === entry.id)) continue;
      sent.set(key, { ...entry, at: -Infinity }); // A lost first response still needs cleanup/expiry.
      try {
        await send(entry);
        sent.set(key, { ...entry, at: now() });
      } catch (error) { report(error); }
    }
    if (failures === initialFailures) failed = false;
  };
  const refresh = () => {
    if (closed) return pending;
    dirty = true;
    if (!refreshing) {
      refreshing = true;
      pending = (async () => {
        try { while (dirty && !closed) { dirty = false; await publish(); } }
        finally { refreshing = false; }
      })().catch(report);
    }
    return pending;
  };
  const timer = refreshMs > 0 ? setInterval(() => { void refresh(); }, refreshMs) : undefined;
  timer?.unref();
  return { refresh, close() {
    return closing ??= (async () => {
      closed = true;
      clearInterval(timer);
      await pending;
      await clearAll();
    })();
  } };
}
