import { realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { readJson } from './store.mjs';
import { sameOccupant } from './herdr.mjs';
import { isId } from './contracts.mjs';
import { delegatedStart } from './delegation.mjs';

// Registration joins durable Pi identity with live Herdr identity. No caller may
// infer a replacement from a pane name or silently follow a different checkpoint.
function nativeBinding(record, agent) {
  return { paneId: record.paneId, sessionId: record.sessionId,
    sessionFile: record.sessionFile, cwd: record.cwd, terminalId: agent?.terminal_id,
    workspaceId: agent?.workspace_id, tabId: agent?.tab_id,
    sessionKind: 'path', sessionValue: record.sessionFile,
    ...(record.pendingSession ? { pendingSession: record.pendingSession } : {}),
    ...(record.delegationId ? { delegationId: record.delegationId } : {}) };
}

export async function readyWorkerRegistration(root, record) {
  if (!record.requiresReady) return; // Registrations predating the provisional protocol.
  const ready = await readJson(join(root, `ready-${record.workerId}.json`));
  if (ready.workerId !== record.workerId || ready.sessionId !== record.sessionId ||
      ready.sessionFile !== record.sessionFile || ready.checkpoint !== record.checkpoint)
    throw new Error('Worker registration is not committed');
}

export async function readWorkerRegistration(root, workerId) {
  const record = await readJson(join(root, `worker-${workerId}.json`));
  await readyWorkerRegistration(root, record);
  const path = await realpath(record.checkpoint);
  if (!(await stat(path)).isFile()) throw new Error('Checkpoint must be a file');
  return { ...record, checkpoint: path };
}

export async function pinnedCheckpoint(root, workerId, binding) {
  const { checkpoint: path } = await readWorkerRegistration(root, workerId);
  if (!binding.checkpoint || path !== binding.checkpoint)
    throw new Error('Registered checkpoint identity changed');
  return path;
}

export async function workerCandidate(root, workerId, route, state, live, supervisorPane) {
  const record = await readWorkerRegistration(root, workerId);
  if (state.retiredWorkers?.[workerId] || Object.values(state.retiredWorkers ?? {}).some(old =>
    old.sessionId === record.sessionId || old.sessionFile === record.sessionFile))
    throw Object.assign(new Error('Retired worker session cannot be registered again'), { code: 'WORKER_RETIRED' });
  const checkpoint = record.checkpoint;
  const agent = live.agents.find(a => a.pane_id === record.paneId);
  const binding = { ...nativeBinding(record, agent), workerId, route, checkpoint, paused: true };
  if (!sameOccupant(agent, binding) || agent.workspace_id !== route ||
      binding.sessionId === state.supervisorSession || agent.pane_id === supervisorPane)
    throw new Error('Worker identity mismatch or self-supervision');
  if (Object.values(state.routes).some(r => r.coordinator &&
      (r.coordinator.paneId === binding.paneId || r.coordinator.sessionId === binding.sessionId)))
    throw new Error('A coordinator cannot become a worker');
  for (const existing of Object.values(state.workers)) {
    if (existing.paneId === binding.paneId || existing.sessionId === binding.sessionId ||
        (await readWorkerRegistration(root, existing.workerId)).checkpoint === checkpoint)
      throw Object.assign(new Error('Duplicate worker or checkpoint'), { code: 'WORKER_CONFLICT' });
  }
  return binding;
}

/** A private IPC request is not approval: require the exact one-use opt-in
 * persisted by the worker command, current owner, and unchanged native binding.
 */
export async function workerStartCandidate(root, request, state, live, supervisorPane) {
  if (!state.acceptStarts || request?.type !== 'worker-start' ||
      request.ownerToken !== state.ownerToken || !isId(request.workerId) || !isId(request.nonce))
    throw new Error('Supervisor is not accepting this worker start; run supervisor start first');
  const record = await readWorkerRegistration(root, request.workerId);
  if (record.managedInput !== true || record.stateRoot !== root || record.start?.nonce !== request.nonce ||
      record.start.ownerToken !== state.ownerToken ||
      record.start.returnToken !== request.returnToken ||
      record.start.replaceWorkerId !== request.replaceWorkerId ||
      (request.replaceWorkerId !== undefined && !isId(request.replaceWorkerId)))
    throw new Error('Worker start has no matching confirmed opt-in');
  if (record.delegationId === request.nonce) await delegatedStart(root, record.delegationId, record, state, live);
  const agent = live.agents.find(item => item.pane_id === record.paneId);
  const existing = state.workers[request.workerId];
  // A start confirmed before Stop cannot become an automatic post-Stop return.
  if (existing?.stopped && request.returnToken !== existing.stopToken)
    throw Object.assign(new Error('Stopped worker requires a fresh own-session return'), { code: 'WORKER_STOPPED' });
  const route = agent?.workspace_id;
  if (!route || (existing && (!sameOccupant(agent, existing) || existing.route !== route ||
      existing.checkpoint !== record.checkpoint)))
    throw new Error('Worker binding changed; inspect before start');
  const others = { ...state, workers: { ...state.workers } };
  delete others.workers[request.workerId];
  const conflicts = Object.values(others.workers).filter(old => old.paneId === record.paneId);
  const replacement = !existing && conflicts.length === 1 &&
    conflicts[0].sessionId !== record.sessionId && conflicts[0].sessionFile !== record.sessionFile ? conflicts[0] : null;
  if (replacement) {
    if (record.checkpoint === replacement.checkpoint)
      throw Object.assign(new Error('Replacement must keep a separate checkpoint'), { code: 'WORKER_CONFLICT' });
    delete others.workers[replacement.workerId];
  }
  const repeated = existing?.lastStartNonce === request.nonce;
  // A replay of an already committed join preserves subsequent pauses. A new
  // request must still name the exact collision that the human confirmed.
  if (request.replaceWorkerId && !repeated && replacement?.workerId !== request.replaceWorkerId)
    throw Object.assign(new Error('Replacement binding changed'), { code: 'WORKER_CONFLICT' });
  const candidate = await workerCandidate(root, request.workerId, route, others, live, supervisorPane);
  return { binding: existing ?? candidate, route, repeated, replacement };
}

// Retirement is not recovery of an uncertain effect. Keep every pending notice
// and resume attached to its original worker until explicitly reconciled.
export function requireReplaceableWorker(state, old, live) {
  if (live.agents.some(agent => agent.agent_session?.value === old.sessionFile))
    throw Object.assign(new Error('Old session is still live'), { code: 'WORKER_LIVE' });
  if (state.inflight[old.workerId] || Object.values(state.notices).some(notice =>
    notice.workerId === old.workerId && ['pending', 'sending', 'uncertain'].includes(notice.status)))
    throw Object.assign(new Error('Old worker delivery needs inspection'), { code: 'DELIVERY_PENDING' });
}

export async function coordinatorCandidate(root, id, state, live, supervisorPane) {
  const record = await readJson(join(root, `coordinator-${id}.json`));
  const agent = live.agents.find(a => a.pane_id === record.paneId);
  const binding = { ...nativeBinding(record, agent), id };
  if (!sameOccupant(agent, binding) || binding.sessionId === state.supervisorSession ||
      agent.pane_id === supervisorPane) throw new Error('Coordinator identity mismatch');
  if (Object.values(state.workers).some(w => w.paneId === binding.paneId || w.sessionId === binding.sessionId))
    throw new Error('A worker cannot become a coordinator');
  return binding;
}
