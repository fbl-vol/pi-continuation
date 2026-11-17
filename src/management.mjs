import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { defaultRoot, readJson, claim } from './store.mjs';
import { isId, readSupervisor, readObservation } from './contracts.mjs';
import { currentSession } from './session.mjs';
import { snapshot, sameOccupant } from './herdr.mjs';
import { ownerAlive, sendAction } from './ipc.mjs';
import { withWorkerHandoff } from './ownership.mjs';
import { setScopePaused, stopWorker } from './policy.mjs';
import { displayName, workerStatus } from './status.mjs';
import { diagnostics } from './diagnostics.mjs';

const controlPath = (root, id) => join(root, `management-${id}.json`);
const unchanged = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const refuse = message => { throw Object.assign(new Error(message), { code: 'MANAGEMENT_REFUSAL' }); };
export const managementMessage = error => error.code === 'MANAGEMENT_REFUSAL' ? error.message :
  error.code === 'DELIVERY_PENDING' ? 'Unresolved worker delivery requires inspection before Stop' :
    'Management request failed; inspect supervision status before retrying';

function requesterBinding(ctx, live, paneId) {
  const session = currentSession(ctx);
  const agent = live.agents.find(a => a.pane_id === paneId);
  const binding = { paneId, sessionId: session.id, sessionFile: session.file,
    cwd: ctx.cwd, terminalId: agent?.terminal_id, workspaceId: agent?.workspace_id,
    tabId: agent?.tab_id, sessionKind: 'path', sessionValue: session.file };
  if (!session.id || !session.file || !binding.terminalId || !sameOccupant(agent, binding))
    refuse('Exact current Pi/Herdr identity is required');
  return binding;
}

async function requireNoPendingSpawn(root, binding) {
  for (const name of await readdir(root)) {
    if (!/^spawn-[a-f0-9-]{36}\.json$/.test(name)) continue;
    const attempt = await readJson(join(root, name));
    if (attempt?.id !== name.slice(6, -5) || typeof attempt.parent?.sessionId !== 'string' ||
        typeof attempt.parent?.sessionFile !== 'string' ||
        !['prepared', 'creating', 'starting', 'enrolling', 'dispatching', 'dispatched', 'held'].includes(attempt.status))
      refuse('Delegation history cannot be verified; inspect before Stop');
    const related = [attempt.parent, attempt.child].some(ref => ref &&
      (ref.sessionId === binding.sessionId || ref.sessionFile === binding.sessionFile));
    if (related && attempt.status !== 'dispatched')
      refuse('Unresolved delegated startup requires inspection before Stop');
  }
}

/** Owner-only transition. The durable opt-in is written by the native command,
 * never by a model activation tool. A consumed/lost request is not replayed. */
export async function applyManagementControl(root, request, state, readLive, commit) {
  if (request?.type !== 'management-control' || !isId(request.id) || request.ownerToken !== state.ownerToken)
    refuse('Management owner changed');
  const intent = await readJson(controlPath(root, request.id));
  if (intent.id !== request.id || intent.ownerToken !== state.ownerToken ||
      intent.supervisorSession !== state.supervisorSession || !['pause', 'stop'].includes(intent.action) ||
      !isId(intent.target?.workerId)) refuse('No matching native management confirmation');
  const binding = state.workers[intent.target.workerId];
  const validate = live => {
    if (!binding || binding.stopped || !unchanged(binding, intent.target) ||
        !sameOccupant(live.agents.find(a => a.pane_id === binding.paneId), binding) ||
        !sameOccupant(live.agents.find(a => a.pane_id === intent.requester?.paneId), intent.requester))
      refuse('Selected session changed; reopen the management menu');
  };
  validate(await readLive());
  return withWorkerHandoff(root, binding.workerId, binding, {}, async () => {
    validate(await readLive());
    if (intent.action === 'stop') {
      const observation = await readObservation(root, binding.workerId);
      if (observation.session.id !== binding.sessionId || observation.session.file !== binding.sessionFile ||
          observation.bootstrapPending) refuse('Worker startup is unverified or unresolved; inspect before Stop');
      await requireNoPendingSpawn(root, binding);
    }
    await claim(join(root, `management-used-${intent.id}.json`), { id: intent.id });
    if (intent.action === 'stop') stopWorker(state, binding.workerId, intent.id);
    else setScopePaused(state, 'worker', binding.workerId, true);
    await commit();
    return { accepted: true, id: intent.id };
  });
}

export async function managementSnapshot(root, socketPath, ctx) {
  let state;
  try { state = await readSupervisor(root); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const live = await snapshot(socketPath);
  const running = !!state && await ownerAlive(root, state.ownerToken);
  const session = currentSession(ctx);
  const workers = [];
  for (const binding of Object.values(state?.workers ?? {})) {
    const agent = live.agents.find(a => a.pane_id === binding.paneId);
    let observation, observationError;
    try { observation = await readObservation(root, binding.workerId); }
    catch (error) { observationError = error.code ?? 'UNEXPECTED'; }
    workers.push({ binding, agent, observation, observationError,
      name: displayName(agent, 'Worker'), status: !running && !binding.stopped ?
        { label: 'Supervisor unavailable', kind: 'unavailable' } : workerStatus(state, binding, agent, observation) });
  }
  return { state, live, running, workers,
    own: workers.find(w => w.binding.sessionId === session.id && w.binding.sessionFile === session.file) };
}

function details(view, row) {
  const { binding, observation, status } = row;
  return [row.name + ' — ' + status.label,
    `Supervisor: ${view.running ? 'running' : 'unavailable'}`,
    `Global pause: ${view.state.paused}; workspace pause: ${view.state.routes[binding.route]?.paused}; worker pause: ${binding.paused}`,
    `Hold: ${observation?.hold === true ? observation.holdReason ?? 'held' : observation ? 'none reported' : 'unknown'}`,
    ...(row.observationError ? ['Observation unavailable; inspect the retained report'] : []),
    `Nudges spent: ${view.state.budgets[binding.workerId]?.count ?? 0}`,
    `Session: ${binding.sessionId}`, `Worker: ${binding.workerId}`,
    `Pane: ${binding.paneId}`, `Checkpoint: ${binding.checkpoint}`,
    ...(binding.reason ? ['Reason: ' + binding.reason] : [])].join('\n');
}

async function requestControl(root, socketPath, paneId, ctx, worker, view, row, stop, current) {
  if (!await worker.confirmDelegation(ctx, stop ? 'Stop supervising this exact worker?' : 'Pause this exact worker?',
    `${row.name}. ` + (stop ? 'Withdraw from the active list, retaining identity, history, budgets and receipts. Only its own explicit Start/Return can rejoin. Unresolved effects refuse Stop.' :
      'Pause only this worker. Other workers and global/workspace pauses, holds and history are unchanged.'))) return;
  if (!current()) refuse('Session changed during confirmation');
  const intent = { id: randomUUID(), action: stop ? 'stop' : 'pause',
    ownerToken: view.state.ownerToken, supervisorSession: view.state.supervisorSession,
    requester: requesterBinding(ctx, await snapshot(socketPath), paneId), target: row.binding };
  if (!current()) refuse('Session changed before management request');
  await claim(controlPath(root, intent.id), intent);
  if (!current()) refuse('Session changed; management confirmation retained but not sent');
  const result = await sendAction(root, { type: 'management-control', id: intent.id,
    ownerToken: intent.ownerToken }, 'supervisor');
  if (result.accepted !== true || result.id !== intent.id)
    refuse(result.message ?? 'Management response uncertain; inspect status, do not replay');
  ctx.ui.notify(stop ? 'Worker stopped; history retained. Return only from that session.' : 'Only the selected worker paused.', 'info');
}

export function bindManagement(pi, worker, supervisor, { root = defaultRoot(),
  socketPath = process.env.HERDR_SOCKET_PATH, paneId = process.env.HERDR_PANE_ID } = {}) {
  const report = diagnostics('management');
  pi.registerCommand('continuation', {
    description: 'Manage this session and known supervised workers without copying IDs',
    handler: async (_args, ctx) => {
      if (ctx.mode !== 'tui' || !paneId || !socketPath || process.env.HERDR_ENV !== '1') {
        ctx.ui.notify('Herdr-managed Pi TUI required', 'warning'); return;
      }
      const session = currentSession(ctx);
      const version = worker.interactionVersion;
      const current = () => unchanged(currentSession(ctx), session) &&
        worker.interactionVersion === version && !worker.promptBlocked;
      const select = async (title, choices) => {
        const value = await worker.selectManagement(ctx, title, choices);
        if (!current()) refuse('Session or prompt changed; reopen the management menu');
        return value;
      };
      try {
        const view = await managementSnapshot(root, socketPath, ctx);
        if (!current()) refuse('Session changed while reading supervision');
        const freshView = async row => {
          const fresh = await managementSnapshot(root, socketPath, ctx);
          if (!current() || fresh.running !== view.running ||
              fresh.state?.ownerToken !== view.state?.ownerToken ||
              (row && !unchanged(fresh.state?.workers[row.binding.workerId], row.binding)))
            refuse('Supervisor or selected session changed; reopen the management menu');
          return fresh;
        };
        const here = view.own ? view.own.status.label : supervisor.active ?
          (view.state?.paused ? 'Supervisor — paused' : 'Supervisor') : 'Not supervised';
        const rows = view.workers.filter(row => !row.binding.stopped);
        const labels = rows.map((row, index) => `${index + 1}. ${row.name} [${row.binding.workspaceId}] — ${row.status.label}`);
        const choices = [...(view.own ? ['This session: details'] : []),
          ...(supervisor.active ? ['Pause global supervision', 'Start global supervision'] :
            view.running ? [view.own ? 'Return this session to supervision' : 'Join this session to supervision'] : ['Start supervisor here']),
          ...labels, 'Close'];
        const choice = await select(`Continuation · ${here}${view.running ? '' : ' · supervisor unavailable'}`, choices);
        if (!choice || choice === 'Close') return;
        await freshView();
        if (choice === 'Pause global supervision') return supervisor.command('pause global', ctx);
        if (choice === 'Start global supervision' || choice === 'Start supervisor here') return supervisor.command('start', ctx);
        if (choice === 'Return this session to supervision' || choice === 'Join this session to supervision') return worker.start(ctx);
        const row = choice === 'This session: details' ? view.own : rows[labels.indexOf(choice)];
        if (!row) return;
        const fresh = await freshView(row);
        const selected = fresh.workers.find(w => w.binding.workerId === row.binding.workerId);
        const action = await select(`${selected.name} · ${selected.status.label}`, ['Details',
          ...(view.running && !row.binding.stopped && sameOccupant(selected.agent, row.binding) ? ['Pause this worker', 'Stop supervising this worker'] : []),
          ...(row === view.own && view.running ? ['Return this session to supervision'] : []), 'Close']);
        if (!action || action === 'Close') return;
        const latest = await freshView(row);
        if (action === 'Details') {
          ctx.ui.notify(details(latest, latest.workers.find(w => w.binding.workerId === row.binding.workerId)), 'info'); return;
        }
        if (action === 'Return this session to supervision') return worker.start(ctx);
        await requestControl(root, socketPath, paneId, ctx, worker, view, row,
          action === 'Stop supervising this worker', current);
      } catch (error) {
        report('manage session', error, ctx);
        ctx.ui.notify(managementMessage(error), 'warning');
      }
    },
  });
}
