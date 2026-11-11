import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicJson, ensureRoot, defaultRoot, claim, readJson } from './store.mjs';
import { listenJson, ownerAlive } from './ipc.mjs';
import { currentSession } from './session.mjs';
import { readSupervisor, readObservation } from './contracts.mjs';
import { diagnostics } from './diagnostics.mjs';
import { snapshot, sameOccupant } from './herdr.mjs';
import { pinnedCheckpoint } from './bindings.mjs';
import { checkpointHash } from './policy.mjs';

export function bindCoordinator(pi, { root = defaultRoot(), paneId = process.env.HERDR_PANE_ID,
  socketPath = process.env.HERDR_SOCKET_PATH } = {}) {
  let close;
  let coordinator;
  let generation = 0;
  let humanPending = false;
  let uiPromptActive = false;
  const report = diagnostics('coordinator');
  const listen = (record, ctx) => listenJson(root, record.id,
    notice => acceptNotice(record, ctx, notice), error => report('accept notice', error, ctx));

  pi.on('input', event => {
    if (event.source === 'interactive' || event.source === 'rpc') {
      generation++;
      humanPending = true;
    }
  });
  pi.on('agent_start', () => { generation++; });
  pi.on('agent_settled', () => { humanPending = false; });
  pi.on('ui_prompt_start', () => { uiPromptActive = true; });
  pi.on('ui_prompt_end', () => { uiPromptActive = false; });
  pi.on('session_start', async (_event, ctx) => {
    coordinator = undefined;
    if (ctx.mode !== 'tui' || process.env.HERDR_ENV !== '1' || !paneId) return;
    const entry = ctx.sessionManager.getBranch().filter(e => e.type === 'custom' &&
      e.customType === 'pi-continuation-coordinator').at(-1)?.data;
    if (!entry || entry.sessionId !== currentSession(ctx).id || entry.paneId !== paneId) return;
    try {
      const record = await readJson(join(root, `coordinator-${entry.id}.json`));
      if (record.sessionId !== entry.sessionId || record.sessionFile !== currentSession(ctx).file) return;
      close = await listen(record, ctx);
      coordinator = record;
    } catch (error) { report('restore registration', error, ctx); }
  });

  async function completionCurrent(state, notice) {
    if (notice.kind !== 'completion') return true;
    const worker = state.workers?.[notice.workerId];
    if (!worker) return false;
    const live = await snapshot(socketPath);
    const agent = live.agents.find(a => a.pane_id === worker.paneId);
    if (!sameOccupant(agent, worker) || agent.agent_status !== 'idle') return false;
    const observation = await readObservation(root, notice.workerId);
    if (observation.stop !== notice.stop || observation.outcome !== 'completed' || observation.hold ||
        observation.session?.id !== worker.sessionId || observation.session?.file !== worker.sessionFile ||
        !notice.reportHash) return false;
    try {
      return checkpointHash(await readFile(await pinnedCheckpoint(root, notice.workerId, worker), 'utf8')) ===
        notice.reportHash;
    } catch { return false; }
  }

  async function acceptNotice(record, ctx, notice) {
    const state = await readSupervisor(root);
    const owner = await readJson(join(root, 'supervisor.lock'));
    const route = state.routes?.[notice.route];
    const now = currentSession(ctx);
    const version = generation;
    if (!await ownerAlive(root, owner.token) ||
        state.paused || route?.paused || route?.coordinator?.id !== record.id ||
        notice.ownerToken !== owner.token || owner.token !== state.ownerToken ||
        now.id !== record.sessionId || now.file !== record.sessionFile ||
        notice.id !== state.notices?.[notice.id]?.id || state.notices[notice.id].status !== 'sending') {
      return { accepted: false };
    }
    if (humanPending || uiPromptActive || !ctx.isIdle()) {
      // No receipt claimed or effect attempted: retryable, unlike post-acceptance rejection.
      return { accepted: false, deferred: true, id: notice.id };
    }
    if (!await completionCurrent(state, notice)) return { accepted: false, stale: true, id: notice.id };

    await claim(join(root, `receipt-${notice.id}.json`), { id: notice.id, status: 'accepted' });
    const completionStillCurrent = await completionCurrent(state, notice);
    const latest = await readSupervisor(root);
    if (!completionStillCurrent || latest.paused || latest.ownerToken !== owner.token || latest.routes?.[notice.route]?.paused ||
        latest.routes?.[notice.route]?.coordinator?.id !== record.id ||
        humanPending || uiPromptActive || !ctx.isIdle() || generation !== version || currentSession(ctx).leaf !== now.leaf) {
      return { accepted: false };
    }
    pi.sendMessage({ customType: 'pi-continuation-notice', display: true,
      content: `Material ${notice.kind} notice for registered worker ${notice.workerId}: ${notice.text}. This is information, not approval authority.` },
    { triggerTurn: true });
    await atomicJson(join(root, `receipt-${notice.id}.json`), { id: notice.id, status: 'sent' });
    return { accepted: true, id: notice.id };
  }

  pi.registerCommand('continuation-coordinator', {
    description: 'Register this exact Pi session as a material-notice recipient; does not grant approval',
    handler: async (_args, ctx) => {
      if (ctx.mode !== 'tui' || !paneId || process.env.HERDR_ENV !== '1')
        throw new Error('Requires a Herdr-managed Pi TUI');
      if (coordinator) { ctx.ui.notify(`Coordinator already registered: ${coordinator.id}`); return; }
      if (!await ctx.ui.confirm('Register coordinator?', 'Receive material notices in this exact session; no continuation or approval authority.')) return;
      try {
        await ensureRoot(root);
        const session = currentSession(ctx);
        const record = { id: randomUUID(), sessionId: session.id, sessionFile: session.file,
          cwd: ctx.cwd, paneId };
        await atomicJson(join(root, `coordinator-${record.id}.json`), record);
        pi.appendEntry('pi-continuation-coordinator', { id: record.id, sessionId: session.id, paneId });
        close = await listen(record, ctx);
        coordinator = record;
        ctx.ui.notify(`Coordinator ${record.id} registered`);
      } catch (error) { throw report('register', error); }
    },
  });
  pi.on('session_shutdown', async () => { generation++; coordinator = undefined; await close?.(); close = undefined; });
}
