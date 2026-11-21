import { watch } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { Type } from 'typebox';
import { ensureRoot, defaultRoot, readJson, atomicJson, claim, release } from './store.mjs';
import { sameOccupant, snapshot, isSettled, request as herdrRequest } from './herdr.mjs';
import { observe } from './subscription.mjs';
import { sendAction, ownerServer } from './ipc.mjs';
import { readSupervisor, readObservation, newSupervisor, isId as uuid } from './contracts.mjs';
import { diagnostics, workerStartRefusal } from './diagnostics.mjs';
import { abandonLaunchApproval, abandonLaunchAssignment, archiveLaunchNotices, closeLaunchAssignment, spawnPath } from './delegation.mjs';
import { attentionContent } from './attention.mjs';
import { applyManagementControl, managementMessage } from './management.mjs';
import { createAnnotations } from './annotations.mjs';
import { checkWorkerHandoff, withWorkerHandoff } from './ownership.mjs';
import { readWorkerRegistration, pinnedCheckpoint, workerCandidate, workerStartCandidate,
  coordinatorCandidate, requireReplaceableWorker } from './bindings.mjs';
import { checkpointHash, planDisposition, recordDisposition, addNotice, prepareResume, confirmResume,
  resolveResume, setScopePaused, returnStoppedWorker, recoverUncertain, recordUnresolvedAttention,
  recipientFor } from './policy.mjs';

const stateFile = root => join(root, 'supervisor.json');
const lockFile = root => join(root, 'supervisor.lock');
const heldReport = 'Report held; requested action was not accepted. Do not retry while held or clear it yourself. ' +
  'After explicit human Clear, fresh attention may allow reassessment of the same current report and stop ID. ' +
  'Clear is not action approval, scope activation or permission to replay a delivered action.';
export function bindSupervisor(pi, { root = defaultRoot(), socketPath = process.env.HERDR_SOCKET_PATH,
  paneId = process.env.HERDR_PANE_ID, allowExperimentalActivation = process.env.PI_CONTINUATION_EXPERIMENTAL_ACTIVATION === '1',
  startOwnerServer = ownerServer } = {}) {
  const bootstrapId = process.env.PI_CONTINUATION_SUPERVISOR_START;
  let state, displayState, annotations;
  const annotationReport = diagnostics('annotations');
  const report = diagnostics('supervisor');
  let diagnosticContext;
  let closeOwner;
  let drainingOwner;
  let closeEvents;
  let watcher;
  let lastSnapshot;
  let wakePending = false;
  let queuedAttention = [];
  let attentionTurn = [];
  let subscriptionLive = false;
  let promptActive = false;
  let inputVersion = 0;
  let serial = Promise.resolve();
  // Serialize snapshots too: a slower old rename must not overwrite a human pause.
  let writes = Promise.resolve();
  let persistenceFailed = false;
  const commit = () => {
    const saved = structuredClone(state);
    const writing = writes.then(async () => {
      if (persistenceFailed) saved.paused = true;
      try {
        await atomicJson(stateFile(root), saved);
        displayState = saved;
        void annotations?.refresh();
      }
      catch (error) {
        // Fence every entry point, including human commands outside the model queue.
        // A failed pause must not leave receivers trusting the old active snapshot.
        persistenceFailed = true;
        state.paused = true;
        subscriptionLive = false;
        closeEvents?.();
        void annotations?.refresh();
        const closing = closeOwner;
        closeOwner = undefined;
        // Withdraw the listener now, but do not await its drain from the IPC
        // handler whose save failed. The handler must return before drain ends.
        if (closing) drainingOwner = closing().catch(failure => {
          report('drain owner endpoint', failure, diagnosticContext);
        });
        throw report('persist state', error, diagnosticContext);
      }
    });
    // Keep the error visible to this caller, but allow the fail-closed pause write.
    writes = writing.catch(() => {});
    return writing;
  };
  const notify = (ctx, message, level = 'info') => ctx.ui.notify(message, level);
  const active = () => !!state && !!closeOwner;
  const queue = work => {
    serial = serial.then(work).catch(async error => {
      state.paused = true;
      if (error !== report.lastError) report('supervise', error, diagnosticContext);
      state.reason = 'Internal error: global continuation paused for inspection';
      state.failure = report.last;
      try { await commit(); }
      catch { /* commit already withdrew the owner; lock/intents remain for inspection. */ }
      return state.reason;
    });
    return serial;
  };
  const current = async (workerId, stop) => {
    const binding = state.workers[workerId];
    const agent = lastSnapshot?.agents.find(a => a.pane_id === binding?.paneId);
    if (!binding || !sameOccupant(agent, binding))
      return { refusal: 'Worker identity unavailable; inspect the exact binding. No action accepted.' };
    if (!isSettled(agent) || agent.completion_seq == null)
      return { refusal: 'Worker has no eligible settled Herdr turn. No action accepted; await fresh attention.' };
    const observation = await readObservation(root, workerId);
    if (observation.session.id !== binding.sessionId || observation.session.file !== binding.sessionFile ||
        !observation.stop || observation.stop !== stop)
      return { refusal: 'Stale report or stop ID; use current attention, not this old request. No action accepted.' };
    if (observation.hold || observation.outcome === 'approval') return { refusal: heldReport };
    if (observation.outcome !== 'completed')
      return { refusal: 'Report is not a successfully completed eligible turn. No action accepted; inspect the worker.' };
    return { observation };
  };
  // Herdr can block mid-turn, before any native assistant stop exists. This is
  // supervisor-owned attention only: never write it into worker observations.
  const blockedStop = (workerId, agent) => {
    if (agent.agent_status !== 'blocked') { delete state.blocked[workerId]; return null; }
    const sequence = agent.state_change_seq;
    if (!Number.isSafeInteger(sequence) || sequence < 0) return null;
    if (state.blocked[workerId]?.sequence !== sequence)
      state.blocked[workerId] = { sequence, stop: randomUUID() };
    return { stop: state.blocked[workerId].stop, outcome: 'blocked',
      statusEvidence: `Herdr reports blocked at state sequence ${sequence}; inspect the worker's current prompt. This status does not grant approval.` };
  };
  const checkpointPath = workerId => pinnedCheckpoint(root, workerId, state.workers[workerId]);
  const acknowledgeWaitingOwner = async id => {
    const binding = state.workers[id];
    const observed = await readObservation(root, id);
    if (observed.outcome === 'completed' && !observed.hold && observed.stop &&
        observed.session.id === binding.sessionId && observed.session.file === binding.sessionFile &&
        state.handled[id] !== observed.stop) {
      recordDisposition(state, id, observed.stop, 'acknowledge');
      return true;
    }
    return false;
  };
  const isolateUnavailable = async () => {
    if (!active() || !lastSnapshot) return;
    let changed = false;
    for (const route of Object.values(state.routes)) {
      if (route.paused || !route.coordinator) continue;
      const agent = lastSnapshot.agents.find(a => a.pane_id === route.coordinator.paneId);
      if (!sameOccupant(agent, route.coordinator)) {
        route.paused = true;
        route.reason = 'Coordinator identity unavailable; inspect before activation';
        changed = true;
      }
    }
    for (const [id, binding] of Object.entries(state.workers)) {
      if (binding.paused) continue;
      const agent = lastSnapshot.agents.find(a => a.pane_id === binding.paneId);
      let reason;
      if (!sameOccupant(agent, binding)) reason = 'Worker identity unavailable';
      else if (binding.recipient && !sameOccupant(lastSnapshot.agents.find(a =>
        a.pane_id === binding.recipient.paneId), binding.recipient)) reason = 'Assignment owner unavailable';
      else {
        try {
          await checkpointPath(id);
          if (binding.delegationId) {
            const spawn = await readJson(spawnPath(root, binding.delegationId));
            if (spawn.status === 'held' || (spawn.status !== 'dispatched' && (await readObservation(root, id)).stop))
              reason = 'Delegated startup/task delivery requires inspection';
          }
          if (!reason) {
            const persisted = await checkWorkerHandoff(root, id, binding);
            if (persisted && binding.pendingSession) {
              delete binding.pendingSession;
              changed = true;
            }
          }
        } catch (error) {
          reason = error.code === 'OWNERSHIP_FENCE' ? 'Worker ownership unavailable' : 'Worker checkpoint unavailable';
          report('read checkpoint', error, diagnosticContext);
          binding.failure = report.last;
        }
      }
      if (!reason || binding.paused) continue;
      binding.paused = true;
      binding.reason = reason;
      changed = true;
      if (recipientFor(state, id)) {
        const noticeId = randomUUID();
        addNotice(state, { id: noticeId, workerId: id, kind: 'blocker',
          text: reason + '; inspect exact binding before activation', route: binding.route });
      }
    }
    if (changed) await commit();
  };
  const attention = async () => {
    if (!active() || !allowExperimentalActivation || !subscriptionLive || state.paused) return [];
    const result = [];
    for (const [id, binding] of Object.entries(state.workers)) {
      if (binding.paused || state.routes[binding.route]?.paused) continue;
      if (state.ownerWaits?.[id]) {
        try {
          if (await acknowledgeWaitingOwner(id)) await commit();
        } catch (error) { if (error.code !== 'ENOENT') report('read waiting owner', error, diagnosticContext); }
        continue;
      }
      try {
        const agent = lastSnapshot?.agents.find(a => a.pane_id === binding.paneId);
        if (!sameOccupant(agent, binding)) continue;
        let stop = blockedStop(id, agent);
        if (!stop) {
          stop = await readObservation(root, id);
          if (stop.session?.id !== binding.sessionId || !stop.stop ||
              !['completed', 'approval', 'aborted', 'error'].includes(stop.outcome)) continue;
          if (stop.outcome === 'completed' && (!isSettled(agent) || agent.completion_seq == null)) continue;
        }
        if (stop.outcome === 'blocked' ? !state.blocked[id].handled : state.handled[id] !== stop.stop)
          result.push({ id, stop });
      } catch (error) {
        // No observation yet is normal; a malformed/unreadable record is not.
        if (error.code !== 'ENOENT') report('read observation', error, diagnosticContext);
      }
    }
    return result;
  };
  const staleCompletion = async notice => {
    notice.status = 'stale';
    const disposition = state.dispositions[notice.workerId];
    if (disposition?.stop === notice.stop && disposition.action === 'completion' &&
        state.handled[notice.workerId] === notice.stop && state.resumed[notice.workerId] !== notice.stop)
      delete state.handled[notice.workerId];
    await commit();
  };
  const flushNotices = async () => {
    if (!active() || !allowExperimentalActivation || !subscriptionLive || state.paused || !lastSnapshot) return;
    for (const notice of Object.values(state.notices ?? {})) {
      // Historical abandonment retains unknown pending outcomes for inspection,
      // but a later route coordinator must never replay a retired sender's notice.
      if (notice.status !== 'pending' || !state.workers[notice.workerId]) continue;
      const route = state.routes[notice.route];
      const recipient = notice.recipient ?? route?.coordinator;
      if (!route || route.paused || !recipient ||
          (notice.recipient && state.workers[notice.workerId]?.recipient?.id !== recipient.id)) continue;
      const owner = notice.recipient && Object.entries(state.workers).find(([, worker]) =>
        worker.role === 'owner' && worker.coordinatorId === recipient.id &&
        worker.sessionId === recipient.sessionId);
      if (owner && ['user', 'released'].includes(state.ownerWaits[owner[0]]?.kind)) continue;
      const agent = lastSnapshot.agents.find(a => a.pane_id === recipient.paneId);
      if (!sameOccupant(agent, recipient)) {
        if (notice.recipient) { state.workers[notice.workerId].paused = true; await commit(); }
        continue;
      }
      if (!isSettled(agent)) continue;
      if (notice.kind === 'completion') {
        try {
          const latest = await readObservation(root, notice.workerId);
          const worker = state.workers[notice.workerId];
          const liveWorker = lastSnapshot.agents.find(a => a.pane_id === worker?.paneId);
          const report = await readFile(await checkpointPath(notice.workerId), 'utf8');
          if (latest.stop !== notice.stop || latest.outcome !== 'completed' || latest.hold ||
              latest.session.id !== worker?.sessionId || latest.session.file !== worker?.sessionFile ||
              !sameOccupant(liveWorker, worker) || !isSettled(liveWorker) ||
              checkpointHash(report) !== notice.reportHash) {
            await staleCompletion(notice); continue;
          }
        } catch (error) {
          if (error.code !== 'ENOENT') report('check completion freshness', error, diagnosticContext);
          continue;
        }
      }
      delete notice.unsentRecipient;
      notice.status = 'sending';
      await commit();
      try {
        const receipt = await withWorkerHandoff(root, notice.workerId, state.workers[notice.workerId],
          { effect: true }, () => sendAction(root, { ...notice, ownerToken: state.ownerToken }, recipient.id));
        if (receipt.accepted === false && receipt.stale === true && receipt.id === notice.id) {
          if (notice.kind === 'completion') await staleCompletion(notice);
          else { notice.status = 'stale'; await commit(); }
          continue;
        }
        if (receipt.accepted === false && receipt.deferred === true && receipt.id === notice.id) {
          notice.status = 'pending';
          await commit();
          continue;
        }
        const saved = await readJson(join(root, `receipt-${notice.id}.json`));
        if (!receipt.accepted || receipt.id !== notice.id || saved.status !== 'sent') throw new Error('Notice delivery uncertain');
        notice.status = 'sent';
        if (owner && state.ownerWaits[owner[0]]?.kind === 'child' &&
            state.ownerWaits[owner[0]].children.includes(notice.workerId)) {
          await acknowledgeWaitingOwner(owner[0]);
          delete state.ownerWaits[owner[0]];
        }
      } catch (error) {
        if (error.code === 'OWNERSHIP_FENCE') {
          state.workers[notice.workerId].paused = true;
          state.workers[notice.workerId].reason = 'Worker ownership unavailable';
          notice.status = 'pending'; // Definite pre-delivery rejection; no notice was accepted.
        } else {
          if (notice.recipient) state.workers[notice.workerId].paused = true;
          else route.paused = true;
          notice.status = 'uncertain';
        }
        report('deliver notice', error, diagnosticContext);
        notice.failure = report.last;
      }
      await commit();
    }
  };
  const wake = async ctx => {
    await isolateUnavailable();
    await flushNotices();
    if (!active() || !allowExperimentalActivation || !subscriptionLive || promptActive || !ctx.isIdle() || wakePending) return;
    const version = inputVersion;
    const pending = await attention();
    if (!pending.length) return;
    for (const { id, stop } of pending) {
      if (state.repair[id]?.stop !== stop.stop) state.repair[id] = { stop: stop.stop, count: 0 };
    }
    await commit();
    const evidence = [];
    for (const { id, stop } of pending) {
      try {
        const path = await checkpointPath(id);
        const reportText = await readFile(path, 'utf8');
        evidence.push({ id, outcome: stop.outcome, stop: stop.stop, hold: stop.hold,
          coordinatorBound: !!recipientFor(state, id),
          checkpointPath: path, reportHash: checkpointHash(reportText),
          finalReply: stop.finalReply, statusEvidence: stop.statusEvidence,
          checkpoint: reportText.slice(0, 4096) });
      } catch (error) {
        if (!state.workers[id].paused) {
          state.workers[id].paused = true;
          state.workers[id].reason = 'Worker checkpoint unavailable';
        }
        report('read attention checkpoint', error, ctx);
        state.workers[id].failure = report.last;
      }
    }
    await commit();
    if (!evidence.length || state.paused || !subscriptionLive || promptActive ||
        !ctx.isIdle() || inputVersion !== version) return;
    wakePending = true;
    queuedAttention = pending.map(({ id, stop }) => ({ id, stop: stop.stop }));
    pi.sendMessage({ customType: 'pi-continuation-attention', display: true,
      content: attentionContent(evidence) },
    { triggerTurn: true });
  };
  const subscribe = async ctx => {
    // Discovery read filters stale pane IDs; the authoritative read follows the
    // subscription acknowledgement so snapshot/event overlap remains safe.
    const discovery = await snapshot(socketPath);
    const candidates = [...Object.values(state.workers).filter(w => !w.stopped).map(w => w.paneId),
      ...Object.values(state.routes).map(r => r.coordinator?.paneId).filter(Boolean),
      ...Object.values(state.workers).map(w => w.recipient?.paneId).filter(Boolean)];
    const paneIds = candidates.filter(id => discovery.agents.some(a => a.pane_id === id));
    closeEvents?.();
    subscriptionLive = false;
    closeEvents = observe(socketPath, value => {
      lastSnapshot = value;
      void queue(() => wake(ctx));
      void annotations?.refresh();
    }, error => {
      report('observe Herdr', error, ctx);
      state.failure = report.last;
      subscriptionLive = false;
      lastSnapshot = undefined;
      state.paused = true;
      void queue(() => commit());
    }, paneIds);
    await closeEvents.ready;
    subscriptionLive = true;
    lastSnapshot = await snapshot(socketPath);
  };
  const reconcile = ctx => queue(async () => {
    if (!active()) return;
    try { lastSnapshot = await snapshot(socketPath); await wake(ctx); }
    catch (error) {
      lastSnapshot = undefined;
      state.paused = true;
      if (error !== report.lastError) report('reconcile', error, ctx);
      state.failure = report.last;
      await commit();
    }
  });

  const startAnnotations = ctx => {
    const agent = lastSnapshot.agents.find(a => a.pane_id === paneId);
    const file = ctx.sessionManager.getSessionFile?.();
    const candidate = { paneId, sessionId: ctx.sessionManager.getSessionId(), sessionFile: file,
      cwd: ctx.cwd, terminalId: agent?.terminal_id, workspaceId: agent?.workspace_id,
      tabId: agent?.tab_id, sessionKind: 'path', sessionValue: file };
    annotations = createAnnotations({ root, socketPath, ownerToken: state.ownerToken,
      readSnapshot: async () => lastSnapshot,
      ownerBinding: file && sameOccupant(agent, candidate) ? candidate : undefined,
      readState: () => active() && subscriptionLive &&
        ctx.sessionManager.getSessionId() === displayState?.supervisorSession ? structuredClone(displayState) : undefined,
      onError: error => annotationReport('publish display', error, ctx) });
    void annotations.refresh();
  };

  const acceptCheckpointRecovery = (request, ctx) => queue(async () => {
    const binding = state.workers[request.workerId];
    if (!active() || !subscriptionLive || !binding || binding.stopped ||
        binding.sessionId !== request.sessionId || binding.sessionFile !== request.sessionFile ||
        !request.stop || state.inflight[request.workerId] ||
        Object.values(state.notices).some(notice => notice.workerId === request.workerId &&
          ['pending', 'sending', 'uncertain'].includes(notice.status)) ||
        ['pause', 'blocker', 'decision'].includes(state.dispositions[request.workerId]?.action))
      return { accepted: false };
    try {
      const live = await snapshot(socketPath);
      const agent = live.agents.find(candidate => candidate.pane_id === binding.paneId);
      if (!sameOccupant(agent, binding) || !isSettled(agent)) return { accepted: false };
      const observed = await readObservation(root, request.workerId);
      if (observed.hold || observed.outcome !== 'completed' || observed.stop !== request.stop ||
          observed.session.id !== binding.sessionId || observed.session.file !== binding.sessionFile ||
          checkpointHash(await readFile(await checkpointPath(request.workerId), 'utf8')) !== request.reportHash)
        return { accepted: false };
    } catch (error) {
      report('verify recovered checkpoint', error, ctx);
      return { accepted: false };
    }
    if (binding.paused) {
      if (binding.reason !== 'Worker checkpoint unavailable') return { accepted: false };
      // Only undo this exact automated failure pause; never clear an explicit
      // worker/route/global pause, disposition, receipt or delivery history.
      binding.paused = false;
      delete binding.reason;
      delete binding.failure;
      await commit();
    }
    await wake(ctx);
    return { accepted: true };
  });

  const acceptWorkerStart = (request, ctx) => queue(async () => {
    if (!active() || !subscriptionLive || !allowExperimentalActivation)
      return { accepted: false, message: 'Supervisor is not ready; inspect before starting this worker.' };
    try {
      const version = inputVersion;
      const live = await snapshot(socketPath);
      const { binding, route, repeated, replacement } = await workerStartCandidate(root, request, state, live, paneId);
      if (state.inflight[request.workerId] || Object.values(state.notices).some(notice =>
        notice.status === 'uncertain' && (notice.recipient ? notice.workerId === request.workerId : notice.route === route)))
        return { accepted: false, code: 'DELIVERY_PENDING', message: workerStartRefusal('DELIVERY_PENDING') };
      if (!repeated) {
        const join = () => withWorkerHandoff(root, request.workerId, binding, {}, async () => {
          // Both session mutexes remain held through the durable transition.
          // Confirmation is not a lease: re-read identity/opt-in after all waits.
          if (replacement) {
            const fresh = await snapshot(socketPath);
            const checked = await workerStartCandidate(root, request, state, fresh, paneId);
            requireReplaceableWorker(state, replacement, fresh);
            if (checked.replacement !== replacement || JSON.stringify(checked.binding) !== JSON.stringify(binding))
              throw Object.assign(new Error('Replacement changed'), { code: 'WORKER_CONFLICT' });
          }
          if (!active() || !subscriptionLive || promptActive || version !== inputVersion ||
              (binding.delegationId === request.nonce && (state.paused || state.routes[route]?.paused)) ||
              (state.workers[request.workerId] && state.workers[request.workerId] !== binding))
            throw new Error('Supervisor changed during worker start');
          if (replacement && !request.replaceWorkerId)
            return { accepted: false, replacementRequired: true, replaceWorkerId: replacement.workerId,
              workerId: request.workerId, nonce: request.nonce, ownerToken: state.ownerToken };
          // A confirmed worker opt-in enables only its newly created route. An
          // independently paused existing route/global scope is never lifted.
          if (replacement) {
            state.retiredWorkers[replacement.workerId] = { ...replacement, paused: true, retiredBy: request.workerId };
            delete state.workers[replacement.workerId];
          }
          state.routes[route] ??= { paused: false, coordinator: null };
          state.workers[request.workerId] ??= binding;
          if (binding.stopped) returnStoppedWorker(state, request.workerId);
          else setScopePaused(state, 'worker', request.workerId, false);
          binding.lastStartNonce = request.nonce;
          await commit();
        });
        let preview;
        if (replacement) {
          requireReplaceableWorker(state, replacement, live);
          preview = await withWorkerHandoff(root, replacement.workerId, replacement, {}, async () => {
            const old = await readWorkerRegistration(root, replacement.workerId);
            if (old.sessionId !== replacement.sessionId || old.sessionFile !== replacement.sessionFile ||
                old.paneId !== replacement.paneId || old.checkpoint !== replacement.checkpoint)
              throw Object.assign(new Error('Old registration changed'), { code: 'OWNERSHIP_FENCE' });
            return join();
          });
        } else await join();
        if (preview) return preview;
        await subscribe(ctx);
        await wake(ctx);
      }
      return { accepted: true, workerId: request.workerId, nonce: request.nonce,
        ownerToken: state.ownerToken, globalPaused: state.paused,
        routePaused: state.routes[route].paused, workerPaused: binding.paused };
    } catch (error) {
      report('join confirmed worker', error, ctx);
      return { accepted: false, code: error.code, message: workerStartRefusal(error.code) };
    }
  });

  const acceptOwnerWait = request => queue(async () => {
    if (!active() || !subscriptionLive || state.paused || !state.acceptStarts) return { accepted: false };
    const worker = state.workers[request.workerId];
    if (worker?.role !== 'owner' || worker.stopped || worker.paused ||
        worker.sessionId !== request.sessionId || worker.sessionFile !== request.sessionFile ||
        worker.coordinatorId !== request.coordinatorId || state.routes[worker.route]?.paused) return { accepted: false };
    const live = await snapshot(socketPath);
    if (!sameOccupant(live.agents.find(a => a.pane_id === worker.paneId), worker)) return { accepted: false };
    const recipient = await coordinatorCandidate(root, request.coordinatorId, state, live, paneId);
    if (recipient.role !== 'owner' || recipient.sessionId !== worker.sessionId) return { accepted: false };
    if (request.kind === 'resume-user') {
      if (state.ownerWaits[request.workerId]?.kind !== 'user') return { accepted: false };
      await acknowledgeWaitingOwner(request.workerId);
      state.ownerWaits[request.workerId] = { kind: 'released',
        stop: (await readObservation(root, request.workerId)).stop };
    } else if (request.kind === 'settled-user') {
      const wait = state.ownerWaits[request.workerId];
      if (wait?.kind !== 'released') return { accepted: false };
      const observed = await readObservation(root, request.workerId);
      if (observed.session.id !== worker.sessionId || observed.session.file !== worker.sessionFile ||
          observed.outcome !== 'completed' || observed.hold || !observed.stop || observed.stop === wait.stop)
        return { accepted: false };
      delete state.ownerWaits[request.workerId];
    } else if (request.kind === 'user') state.ownerWaits[request.workerId] = { kind: 'user' };
    else if (request.kind === 'child' && Array.isArray(request.children) && request.children.length &&
        request.children.every(id => uuid(id) && state.workers[id]?.recipient?.id === recipient.id &&
          state.workers[id]?.recipient?.sessionId === recipient.sessionId)) {
      if (['user', 'released'].includes(state.ownerWaits[request.workerId]?.kind)) return { accepted: false };
      state.ownerWaits[request.workerId] = { kind: 'child', children: [...new Set(request.children)] };
    } else return { accepted: false };
    await commit();
    if (request.kind === 'child' || request.kind === 'settled-user') await flushNotices();
    return { accepted: true };
  });

  const acceptManagement = (request, ctx) => queue(async () => {
    if (!active() || !subscriptionLive) return { accepted: false, message: 'Supervisor unavailable' };
    try {
      return await applyManagementControl(root, request, state, () => snapshot(socketPath), commit);
    } catch (error) {
      report('manage worker', error, ctx);
      return { accepted: false, message: managementMessage(error) };
    }
  });

  const acceptLaunchActivate = (request, ctx) => queue(async () => {
    if (!active() || !subscriptionLive || request.ownerToken !== state.ownerToken)
      return { accepted: false, message: 'Supervisor ownership unavailable' };
    if (state.paused && (state.failure || persistenceFailed ||
        (state.acceptStarts && state.reason !== 'Explicit global pause') ||
        (!state.acceptStarts && state.reason && state.reason !== 'Explicit global pause')))
      return { accepted: false, message: 'Supervisor fault or unknown pause requires inspection before activation' };
    if (!state.acceptStarts || state.paused) {
      state.acceptStarts = true;
      setScopePaused(state, 'global', undefined, false);
      await commit();
      lastSnapshot = await snapshot(socketPath);
      await wake(ctx);
    }
    return { accepted: true, ownerToken: state.ownerToken };
  });

  const acceptLaunchClose = request => queue(async () => {
    const version = inputVersion;
    const stillCurrent = () => active() && subscriptionLive && !state.paused && !promptActive &&
      version === inputVersion && state.acceptStarts && request.ownerToken === state.ownerToken;
    if (!uuid(request.id) || !uuid(request.grantId) || !stillCurrent())
      return { accepted: false, message: 'Supervisor unavailable for assignment closeout' };
    try {
      const grantId = await closeLaunchAssignment(root, request, state,
        id => herdrRequest(socketPath, 'pane.get', { pane_id: id }), () => snapshot(socketPath), stillCurrent, commit);
      return { accepted: true, id: request.id, grantId };
    } catch (error) {
      return { accepted: false, message: error.code ? 'Closeout evidence unavailable; inspect supervisor status' : error.message };
    }
  });

  const acceptLaunchAbandonAssignment = request => queue(async () => {
    const version = inputVersion;
    const stillCurrent = () => active() && subscriptionLive && !state.paused && !promptActive &&
      version === inputVersion && state.acceptStarts && request.ownerToken === state.ownerToken;
    if (!uuid(request.id) || !uuid(request.grantId) || !stillCurrent())
      return { accepted: false, message: 'Supervisor unavailable for assignment abandonment' };
    try {
      const grantId = await abandonLaunchAssignment(root, request, state,
        id => herdrRequest(socketPath, 'pane.get', { pane_id: id }), () => snapshot(socketPath), stillCurrent, commit);
      return { accepted: true, id: request.id, grantId };
    } catch (error) {
      return { accepted: false, message: error.code ? 'Abandonment evidence unavailable; inspect supervisor status' : error.message };
    }
  });

  const acceptLaunchAbandon = request => queue(async () => {
    const version = inputVersion;
    const stillCurrent = () => active() && subscriptionLive && !state.paused && !promptActive &&
      version === inputVersion && state.acceptStarts && request.ownerToken === state.ownerToken;
    if (!uuid(request.id) || !uuid(request.workerId) || !stillCurrent())
      return { accepted: false, message: 'Supervisor unavailable for assignment abandonment' };
    try {
      const workerId = await abandonLaunchApproval(root, request, state,
        id => herdrRequest(socketPath, 'pane.get', { pane_id: id }), () => snapshot(socketPath), stillCurrent, commit);
      return { accepted: true, id: request.id, workerId };
    } catch (error) {
      return { accepted: false, message: error.code ? 'Historical approval evidence unavailable; inspect supervisor status' : error.message };
    }
  });

  const acceptLaunchArchive = request => queue(async () => {
    const version = inputVersion;
    const stillCurrent = () => active() && subscriptionLive && !state.paused && !promptActive &&
      version === inputVersion && state.acceptStarts && request.ownerToken === state.ownerToken;
    if (!uuid(request.id) || !stillCurrent()) return { accepted: false, message: 'Supervisor unavailable for notice disposition' };
    try {
      const archived = await archiveLaunchNotices(root, request, state,
        id => herdrRequest(socketPath, 'pane.get', { pane_id: id }), () => snapshot(socketPath), stillCurrent, commit);
      return { accepted: true, id: request.id, archived };
    } catch (error) {
      // Expected/refused archival is not a global continuation failure.
      return { accepted: false, message: error.code ? 'Historical notice evidence unavailable; inspect supervisor status' : error.message };
    }
  });

  const command = async (args, ctx, { bootstrap = false } = {}) => {
      diagnosticContext = ctx;
      if (ctx.mode !== 'tui' || !socketPath || process.env.HERDR_ENV !== '1') {
        notify(ctx, 'Herdr-managed Pi TUI required', 'error'); return;
      }
      const [verb, kind, id] = args.trim().split(/\s+/);
      if (verb === 'init' || verb === 'start') {
        if (active()) {
          if (verb === 'init' || (state.acceptStarts && !state.paused)) {
            notify(ctx, 'Supervisor already running; existing scope pauses preserved'); return;
          }
          if (!allowExperimentalActivation || !subscriptionLive)
            throw new Error('Supervisor unavailable; inspect before starting');
          if (!bootstrap && !await ctx.ui.confirm('Start continuation supervisor?',
            'Enable this supervisor and accept explicitly opted-in workers. Existing worker and route pauses remain unchanged.')) return;
          state.acceptStarts = true;
          setScopePaused(state, 'global', undefined, false);
          await commit();
          await reconcile(ctx);
          notify(ctx, 'Supervisor started; use /continuation-worker start in each selected worker'); return;
        }
        const localRoles = ctx.sessionManager.getBranch?.() ?? [];
        if (localRoles.some(e => e.type === 'custom' &&
            ['pi-continuation-worker', 'pi-continuation-coordinator'].includes(e.customType) &&
            e.data?.sessionId === ctx.sessionManager.getSessionId()))
          throw new Error('A worker or coordinator cannot become the supervisor');
        if (verb === 'start' && !allowExperimentalActivation)
          throw new Error('Start requires the ordinary extension profile');
        if (!bootstrap && !await ctx.ui.confirm('Start continuation supervisor?', verb === 'start' ?
          'Enable this supervisor and accept only workers explicitly opting in with /continuation-worker start. Existing worker and route pauses remain unchanged.' :
          'Claim one supervisor owner; all new scopes remain paused.')) return;
        await ensureRoot(root);
        const token = randomUUID();
        await claim(lockFile(root), { token, pid: process.pid, sessionId: ctx.sessionManager.getSessionId() });
        try {
          closeOwner = await startOwnerServer(root, token, request => request?.type === 'management-control' ?
            acceptManagement(request, ctx) : request?.type === 'launch-activate' ?
              acceptLaunchActivate(request, ctx) : request?.type === 'owner-wait' ?
              acceptOwnerWait(request) : request?.type === 'launch-archive' ? acceptLaunchArchive(request) :
              request?.type === 'launch-abandon-assignment' ? acceptLaunchAbandonAssignment(request) :
              request?.type === 'launch-abandon' ? acceptLaunchAbandon(request) :
              request?.type === 'launch-close' ? acceptLaunchClose(request) :
              request?.type === 'checkpoint-recovered' ? acceptCheckpointRecovery(request, ctx) : acceptWorkerStart(request, ctx));
          try { state = await readSupervisor(root); }
          catch (error) {
            if (error.code !== 'ENOENT') throw report('restore state', error);
            state = newSupervisor();
          }
          const supervisorSession = ctx.sessionManager.getSessionId();
          if (Object.values(state.workers).some(w => w.sessionId === supervisorSession) ||
              Object.values(state.routes).some(r => r.coordinator?.sessionId === supervisorSession))
            throw new Error('A worker or coordinator cannot become the supervisor');
          state.supervisorSession = supervisorSession;
          state.acceptStarts = verb === 'start';
          if (verb === 'start') setScopePaused(state, 'global', undefined, false);
          for (const [workerId, binding] of Object.entries(state.workers)) {
            if (binding.checkpoint) continue;
            // Older bindings did not pin checkpoint identity; observation is safe,
            // but continuing from a newly pinned path needs explicit activation.
            binding.paused = true;
            binding.reason = 'Checkpoint binding requires inspection and activation';
            try {
              binding.checkpoint = (await readWorkerRegistration(root, workerId)).checkpoint;
            } catch (error) {
              report('restore checkpoint binding', error, ctx);
              binding.failure = report.last;
            }
          }
          recoverUncertain(state);
          if (!allowExperimentalActivation) state.paused = true;
          state.ownerToken = token;
          state.ownerPid = process.pid;
          await commit();
          await subscribe(ctx);
          startAnnotations(ctx);
          watcher = watch(root, (_event, filename) => {
            // Own state/receipt writes must not retry a deferred notice in a hot loop.
            if (filename && /^(observation|spawn)-[a-f0-9-]{36}\.json$/.test(filename.toString()))
              void queue(() => wake(ctx));
          });
          notify(ctx, verb === 'start' ?
            'Supervisor started; use /continuation-worker start in each selected worker' :
            'Supervisor claimed; global pause remains ' + state.paused);
        } catch (error) {
          const closingAnnotations = annotations?.close(); annotations = undefined;
          closeEvents?.(); closeEvents = undefined;
          await closeOwner?.(); closeOwner = undefined;
          await release(lockFile(root), token);
          await closingAnnotations;
          throw error;
        }
        return;
      }
      if (!active()) { notify(ctx, 'Run /continuation-supervisor init first', 'warning'); return; }
      if (verb === 'status') {
        const workers = {};
        for (const [workerId, binding] of Object.entries(state.workers)) {
          let observed;
          try { observed = await readObservation(root, workerId); }
          catch { observed = { outcome: 'unknown' }; }
          workers[workerId] = { route: binding.route, paneId: binding.paneId,
            paused: binding.paused, reason: binding.reason, failure: binding.failure,
            outcome: observed.outcome, stop: observed.stop, ownerWait: state.ownerWaits[workerId],
            handled: state.handled[workerId], nudges: state.budgets[workerId]?.count ?? 0,
            repair: state.repair[workerId], inflight: state.inflight[workerId],
            next: binding.paused ? 'inspect and explicitly activate' :
              observed.stop && observed.stop !== state.handled[workerId] ?
                'disposition pending' : 'await new work' };
        }
        const retiredWorkers = Object.fromEntries(Object.entries(state.retiredWorkers).map(([id, old]) =>
          [id, { paneId: old.paneId, sessionId: old.sessionId, retiredBy: old.retiredBy }]));
        notify(ctx, JSON.stringify({ globalPaused: state.paused, globalReason: state.reason,
          failure: state.failure, subscriptionLive,
          routes: state.routes, workers, notices: state.notices, retiredWorkers }).slice(0, 6000)); return;
      }
      if (verb === 'coordinator') {
        if (!state.routes[kind] || !uuid(id)) throw new Error('Usage: coordinator <route> <coordinator-id>');
        const live = await snapshot(socketPath);
        const binding = await coordinatorCandidate(root, id, state, live, paneId);
        if (binding.role === 'owner') throw new Error('An assignment owner cannot be a workspace-wide coordinator');
        const existing = state.routes[kind].coordinator;
        if (existing) {
          if (existing.id === id) { notify(ctx, 'Coordinator already bound; pauses preserved'); return; }
          throw new Error('Coordinator already bound; replacement requires explicit recovery');
        }
        if (!await ctx.ui.confirm('Bind exact coordinator?', `Route ${kind}, session ${binding.sessionId}. No approval authority is delegated.`)) return;
        state.routes[kind].coordinator = binding;
        await commit();
        await subscribe(ctx);
        return;
      }
      if (verb === 'add') {
        if (!uuid(kind) || !id) throw new Error('Usage: add <worker-id> <route>');
        if (state.workers[kind]) { notify(ctx, 'Already registered; existing pause preserved'); return; }
        const live = await snapshot(socketPath);
        const binding = await workerCandidate(root, kind, id, state, live, paneId);
        if (!await ctx.ui.confirm('Register exact worker?',
          `Route ${id}, pane ${binding.paneId}, session ${binding.sessionId}. Confirm old continuation owner is stopped before activation.`)) return;
        state.routes[id] ??= { paused: true, coordinator: null };
        state.workers[kind] = binding;
        await commit();
        await subscribe(ctx);
        notify(ctx, 'Registered paused; activate scopes explicitly'); return;
      }
      if (verb === 'handoff') {
        const reference = JSON.parse(args.trim().slice(verb.length).trim());
        const workerId = reference.target?.workerId;
        const binding = state.workers[workerId];
        if (!binding?.paused || binding.handoff || state.handled[workerId] || state.inflight[workerId] ||
            state.budgets[workerId] || Object.values(state.notices).some(n => n.workerId === workerId))
          throw new Error('Handoff requires a newly bound paused worker without prior dispositions');
        if (!await ctx.ui.confirm('Attach selected ownership handoff?',
          'Confirm the old adapter enforces this witness and you inspected its retained pauses, spent budget, pending notices and history. The current stop will not be replayed; the new budget starts exhausted until evidenced progress. No scope is activated.')) return;
        const candidate = { ...binding, handoff: reference };
        await withWorkerHandoff(root, workerId, candidate, {}, async () => {
          const observation = await readObservation(root, workerId);
          if (!observation.stop || observation.bootstrapPending || observation.outcome === 'working' ||
              observation.session.id !== binding.sessionId || observation.session.file !== binding.sessionFile)
            throw new Error('Handoff requires an observed exact settled stop; no initial-run inference');
          const checkpoint = await readFile(await checkpointPath(workerId), 'utf8');
          binding.handoff = reference;
          state.handled[workerId] = observation.stop;
          state.resumed[workerId] = observation.stop; // Never replay a stop the old owner may have delivered.
          state.budgets[workerId] = { count: 2, hash: checkpointHash(checkpoint), checkpoint };
          await commit();
        });
        notify(ctx, 'Ownership attached paused; old history retained, current stop not replayed'); return;
      }
      if (verb === 'resolve-notice') {
        const notice = state.notices[kind];
        if (!uuid(kind) || notice?.status !== 'uncertain') throw new Error('Usage: resolve-notice <notice-id>');
        if (!await ctx.ui.confirm('Resolve uncertain notice?',
          `After inspecting coordinator state, mark notice ${kind} resolved without resending. Route remains paused.`)) return;
        notice.status = 'resolved';
        await commit(); return;
      }
      if (verb === 'resolve') {
        if (!uuid(kind) || !state.inflight[kind] || id !== state.inflight[kind].id)
          throw new Error('Usage: resolve <worker-id> <pending-action-id>');
        const intent = state.inflight[kind];
        if (!await ctx.ui.confirm('Resolve ambiguous action?',
          `After inspecting receipt and worker state, mark old stop ${intent.stop} handled without retry. Worker remains paused.`)) return;
        resolveResume(state, kind);
        await commit(); return;
      }
      if (verb === 'activate' || verb === 'pause') {
        const enabled = verb === 'activate';
        if (enabled && !allowExperimentalActivation)
          throw new Error('Activation disabled: Pi prompt-hold timing is not proven safe for real workers');
        if (enabled && !subscriptionLive) throw new Error('Herdr subscription lost; restart owner and inspect before activation');
        if (enabled && ((kind === 'worker' && state.inflight[id]) ||
            (kind === 'route' && Object.values(state.notices).some(n => n.route === id && n.status === 'uncertain'))))
          throw new Error('Uncertain delivery requires explicit inspection and resolution');
        const target = kind === 'global' ? state : kind === 'route' ? state.routes[id] :
          kind === 'worker' ? state.workers[id] : undefined;
        if (!target) throw new Error('Unknown scope or id');
        if (!await ctx.ui.confirm(`${verb} ${kind}?`,
          `Set only ${kind} ${id ?? ''} to ${enabled ? 'active' : 'paused'}? Other pauses remain unchanged.`)) return;
        const updateScope = async () => {
          if (enabled && kind === 'worker') {
            const live = await snapshot(socketPath);
            const agent = live.agents.find(a => a.pane_id === target.paneId);
            if (!sameOccupant(agent, target))
              throw new Error('Worker identity unavailable; inspect before activation');
          }
          setScopePaused(state, kind, id, !enabled);
          await commit();
        };
        if (enabled && kind === 'worker')
          await withWorkerHandoff(root, id, target, {}, updateScope);
        else await updateScope();
        if (enabled) await reconcile(ctx);
        return;
      }
      notify(ctx, 'Unknown continuation-supervisor action', 'warning');
  };
  pi.registerCommand('continuation-supervisor', {
    description: 'Start automatic enrollment: start | explicit setup/status/control: init | status | add <worker-id> <route> | handoff <JSON reference> | coordinator <route> <id> | activate/pause <global|route|worker> [id] | resolve <worker-id> <action-id>',
    handler: command,
  });

  pi.registerTool({
    name: 'continuation_disposition', label: 'Continuation disposition',
    description: 'Disposition an exact stop. Resume/completion cite pinned checkpoint evidence; a blocker, decision or pause may cite the worker final reply or labeled Herdr blocked status evidence. Completion also requires reportHash and whole-backlog interpretation. Never grants approval or lifts pauses.',
    parameters: Type.Object({ workerId: Type.String(), stop: Type.String(),
      action: Type.Union([Type.Literal('resume'), Type.Literal('acknowledge'), Type.Literal('pause'), Type.Literal('notify')]),
      kind: Type.Optional(Type.Union([Type.Literal('completion'), Type.Literal('blocker'), Type.Literal('decision')])),
      evidence: Type.String(), reportHash: Type.Optional(Type.String()) }),
    async execute(_toolCallId, args, _signal, _update, ctx) {
      diagnosticContext = ctx;
      const text = await queue(async () => {
        if (_signal?.aborted) return 'Cancelled';
        if (!active() || !uuid(args.workerId) || !uuid(args.stop) || !args.evidence.trim())
          return 'No active owner or missing evidence';
        if (!allowExperimentalActivation) return 'Activation disabled: prompt-hold boundary unverified';
        const binding = state.workers[args.workerId];
        if (!binding || binding.stopped || (args.action !== 'acknowledge' &&
            (state.paused || binding.paused || state.routes[binding.route]?.paused))) return 'Paused';
        const decisionWait = () => ['user', 'released'].includes(state.ownerWaits[args.workerId]?.kind);
        if (args.action === 'resume' && decisionWait())
          return 'Owner is waiting for a user decision; no continuation through this gate';
        lastSnapshot = await snapshot(socketPath);
        const reviewedAgent = lastSnapshot.agents.find(a => a.pane_id === binding.paneId);
        const reviewedInput = inputVersion;
        await isolateUnavailable();
        if (args.action !== 'acknowledge' &&
            (binding.paused || state.routes[binding.route]?.paused)) return 'Paused';
        let observation;
        try {
          if (args.action === 'notify' || args.action === 'pause') {
            const agent = lastSnapshot.agents.find(a => a.pane_id === binding.paneId);
            if (sameOccupant(agent, binding) && (isSettled(agent) || agent.agent_status === 'blocked')) {
              observation = blockedStop(args.workerId, agent);
              if (!observation) {
                observation = await readObservation(root, args.workerId);
                if (observation.session?.id !== binding.sessionId) observation = undefined;
              }
            }
          } else {
            const currentReport = await current(args.workerId, args.stop);
            if (currentReport.refusal) return currentReport.refusal;
            observation = currentReport.observation;
          }
        } catch (error) {
          binding.paused = true;
          report('read disposition observation', error, ctx);
          binding.failure = report.last;
          await commit();
          return 'Worker observation unreadable; only that worker paused';
        }
        if (!observation || observation.stop !== args.stop)
          return 'Stale report or stop ID; use current attention, not this old request. No action accepted.';
        if (args.action === 'notify' && args.kind === 'completion') {
          if (observation.hold || observation.outcome === 'approval') return heldReport;
          if (observation.outcome !== 'completed')
            return 'Report is not a successfully completed eligible turn; completion notice not accepted.';
        }
        if (args.action === 'resume' && state.resumed[args.workerId] === args.stop)
          return 'Continuation already delivered for this stop; do not resend it.';
        if (args.action !== 'notify' && state.handled[args.workerId] === args.stop)
          return 'Stop already handled; do not replay it. Only fresh attention can request a new assessment.';
        let checkpoint;
        try {
          checkpoint = await readFile(await checkpointPath(args.workerId), 'utf8');
        } catch (error) {
          binding.paused = true;
          report('read disposition checkpoint', error, ctx);
          binding.failure = report.last;
          await commit();
          return 'Worker checkpoint unreadable; only that worker paused';
        }
        const plan = planDisposition(state, args, checkpoint,
          observation.finalReply ?? observation.statusEvidence ?? '');
        if (plan.kind === 'reject') return plan.message;
        const dispose = action => {
          if (state.blocked[args.workerId]?.stop === args.stop) {
            state.blocked[args.workerId].handled = true;
            binding.paused = true;
          } else recordDisposition(state, args.workerId, args.stop, action);
        };
        if (plan.kind === 'notify') {
          const notice = addNotice(state, { id: randomUUID(), ...plan.notice });
          dispose(args.kind);
          await commit();
          await flushNotices();
          return `Material notice ${notice.status}`;
        }
        if (plan.kind === 'pause' || plan.kind === 'acknowledge') {
          dispose(plan.kind);
          await commit();
          return plan.kind === 'pause' ? 'Worker paused' : 'Stop acknowledged; independent acceptance not implied';
        }
        if (plan.kind === 'budget-exhausted') {
          recordDisposition(state, args.workerId, args.stop, 'blocker');
          binding.reason = plan.reason;
          if (recipientFor(state, args.workerId)) {
            addNotice(state, { id: randomUUID(), workerId: args.workerId, stop: args.stop,
              kind: 'blocker', text: plan.reason + '; inspect before resuming', route: binding.route });
          }
          await commit();
          await flushNotices();
          return 'Two nudges without evidenced progress; worker paused';
        }
        if (_signal?.aborted || state.paused || binding.paused || state.routes[binding.route]?.paused ||
            decisionWait()) return 'Cancelled, paused or waiting for a user decision';
        const id = randomUUID();
        const intent = prepareResume(state, args.workerId, args.stop, id);
        await commit();
        try {
          await atomicJson(join(root, `intent-${id}.json`), intent);
          if (_signal?.aborted) throw new Error('Cancelled before delivery');
          const delivery = await snapshot(socketPath);
          const agent = delivery.agents.find(a => a.pane_id === binding.paneId);
          if (_signal?.aborted || !subscriptionLive || promptActive || inputVersion !== reviewedInput ||
              state.paused || binding.paused || state.routes[binding.route]?.paused || decisionWait() ||
              !sameOccupant(agent, binding) || !isSettled(agent) ||
              !Number.isSafeInteger(reviewedAgent.state_change_seq) ||
              agent.state_change_seq !== reviewedAgent.state_change_seq ||
              agent.completion_seq !== reviewedAgent.completion_seq) {
            // Definite pre-delivery refusal, not an ambiguous accepted request.
            await atomicJson(join(root, `intent-${id}.json`), { ...intent, status: 'rejected' });
            delete state.inflight[args.workerId];
            recordDisposition(state, args.workerId, args.stop, 'pause');
            await commit();
            return 'Worker state changed; paused before delivery; no continuation sent';
          }
          const result = await sendAction(root, intent);
          const receipt = await readJson(join(root, `receipt-${id}.json`));
          if (!result.accepted || result.id !== id || receipt.status !== 'sent')
            throw new Error('Receipt not confirmed');
          confirmResume(state, intent, plan.budget);
          await commit();
          return 'Continuation delivered to exact native stop; not task acceptance';
        } catch (error) {
          binding.paused = true;
          if (error !== report.lastError) report('deliver continuation', error, ctx);
          binding.failure = report.last;
          await commit();
          return 'Ambiguous delivery: worker paused for inspection; no retry';
        }
      });
      return { content: [{ type: 'text', text }], details: {} };
    },
  });

  pi.on('input', event => {
    if (event.source === 'interactive' || event.source === 'rpc') inputVersion++;
  });
  pi.on('ui_prompt_start', () => { promptActive = true; inputVersion++; });
  pi.on('ui_prompt_end', () => { promptActive = false; });
  pi.on('session_start', async (event, ctx) => {
    if (active()) { void reconcile(ctx); return; }
    if (!bootstrapId || event.reason !== 'startup') return;
    const path = join(root, `supervisor-start-${bootstrapId}.json`);
    let intent;
    try {
      intent = await readJson(path);
      const pending = await readJson(join(root, 'supervisor-start-pending.json'));
      if (!uuid(bootstrapId) || pending.token !== bootstrapId || intent.id !== bootstrapId ||
          intent.status !== 'start-requested' || intent.pane?.pane_id !== paneId ||
          intent.cwd !== ctx.cwd || !ctx.sessionManager.getSessionFile())
        throw new Error('Supervisor bootstrap identity or intent changed');
      const activating = { ...intent, status: 'activating',
        sessionId: ctx.sessionManager.getSessionId(), sessionFile: ctx.sessionManager.getSessionFile() };
      await atomicJson(path, activating);
      intent = activating;
      await command('start', ctx, { bootstrap: true });
      if (!active() || state.supervisorSession !== ctx.sessionManager.getSessionId() ||
          state.paused || !state.acceptStarts)
        throw new Error('Supervisor bootstrap was not established');
      await atomicJson(path, { ...intent, status: 'ready', sessionId: state.supervisorSession });
    } catch (error) {
      if (['start-requested', 'activating'].includes(intent?.status))
        await atomicJson(path, { ...intent, status: 'held', failure: error.message });
      throw error;
    }
  });
  pi.on('before_agent_start', event => {
    if (event.messageType !== 'custom' || event.message?.customType !== 'pi-continuation-attention') return;
    attentionTurn = queuedAttention;
    queuedAttention = [];
    wakePending = false;
  });
  pi.on('agent_settled', (event, ctx) => {
    if (!active()) return;
    if (event.aborted) {
      state.paused = true;
      state.reason = 'Supervisor turn aborted; inspect before activation';
      attentionTurn = [];
      return queue(() => commit());
    }
    const attempted = attentionTurn;
    attentionTurn = [];
    if (!attempted.length) {
      if (!wakePending) void queue(() => wake(ctx));
      return;
    }
    return queue(async () => {
      for (const { id, stop } of await attention()) {
        if (!attempted.some(item => item.id === id && item.stop === stop.stop)) continue;
        recordUnresolvedAttention(state, id, stop.stop, randomUUID());
      }
      await commit();
      await wake(ctx);
    });
  });
  pi.on('session_shutdown', async () => {
    const closingAnnotations = annotations?.close(); annotations = undefined;
    watcher?.close(); closeEvents?.(); subscriptionLive = false;
    await serial; // Finish any queued receipt/notice before releasing the owner and state root.
    await writes; // Human command snapshots share this tail, not the model queue.
    if (closeOwner) {
      const token = state.ownerToken;
      await closeOwner(); closeOwner = undefined;
      await release(lockFile(root), token);
    }
    // A failed-save handler cannot wait for its own drain. Shutdown can and must.
    await drainingOwner;
    await closingAnnotations;
  });
  return { get active() { return active(); }, command };
}
