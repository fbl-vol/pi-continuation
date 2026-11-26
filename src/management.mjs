import { randomUUID } from 'node:crypto';
import { Type } from 'typebox';
import { join } from 'node:path';
import { defaultRoot, readJson, claim } from './store.mjs';
import { isId, ownerRolloverBlocker, readSupervisor, readObservation } from './contracts.mjs';
import { currentSession } from './session.mjs';
import { snapshot, sameOccupant } from './herdr.mjs';
import { ownerAlive, sendAction } from './ipc.mjs';
import { withWorkerHandoff } from './ownership.mjs';
import { unresolvedStartupForWorker } from './delegation.mjs';
import { setScopePaused, stopWorker } from './policy.mjs';
import { displayName, workerStatus } from './status.mjs';
import { diagnostics } from './diagnostics.mjs';
import { deliveryFields, reviewFixPreferenceGuidance, readDeliveryPreferences,
  saveDeliveryPreferences, readAssignmentDeliveryPreferences,
  saveAssignmentDeliveryPreferences } from './preferences.mjs';

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
      const startup = await unresolvedStartupForWorker(root, binding);
      if (startup?.unverified) refuse('Delegation history cannot be verified; inspect before Stop');
      if (startup?.related) refuse('Unresolved delegated startup requires inspection before Stop');
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
    const pane = live.panes?.find(p => p.pane_id === binding.paneId);
    const current = sameOccupant(agent, binding);
    let observation, observationError;
    try { observation = await readObservation(root, binding.workerId); }
    catch (error) { observationError = error.code ?? 'UNEXPECTED'; }
    let status = workerStatus(state, binding, agent, observation);
    if (!binding.stopped && !current)
      status = { label: pane || agent ? 'Session changed' : 'Pane closed', kind: 'unavailable' };
    else if (!binding.stopped && !running)
      status = { label: 'Supervisor unavailable', kind: 'unavailable' };
    workers.push({ binding, agent, observation, observationError, current,
      name: displayName(current ? agent : undefined, 'Worker', pane?.label), status });
  }
  return { state, live, running, workers,
    own: workers.find(w => w.binding.sessionId === session.id && w.binding.sessionFile === session.file) };
}

function rolloverDetails(state, binding) {
  const blocker = ownerRolloverBlocker(state, { ...binding, id: binding.coordinatorId });
  return blocker ? [`Queued assignment ${blocker.queuedId ?? ''} could not start: ${blocker.reason}`, blocker.next] : [];
}

function details(view, row) {
  const { binding, observation, status } = row;
  return [row.name + ' — ' + status.label,
    `Supervisor: ${view.running ? 'running' : 'unavailable'}`,
    ...(binding.role === 'owner' ? rolloverDetails(view.state, binding) : []),
    `Global pause: ${view.state.paused}; workspace pause: ${view.state.routes[binding.route]?.paused}; worker pause: ${binding.paused}`,
    `Hold: ${observation?.hold === true ? observation.holdReason ?? 'held' : observation ? 'none reported' : 'unknown'}`,
    ...(observation?.hold && observation.holdError ? [
      observation.holdError.kind === 'run' ? 'Cause: a Pi turn ended in error; later success does not clear this hold.' :
        'Cause: the continuation checkpoint could not be updated.',
      `Hold recorded: ${new Date(observation.holdError.at).toISOString()}`,
      'Resolve the cause, then use Start/Return or Clear this session hold in /continuation in that worker.',
    ] : observation?.hold && observation.holdReason === 'error' ? [
      'Cause/time unavailable for this retained error hold; inspect the worker session before clearing it.',
    ] : []),
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

export function bindManagement(pi, worker, supervisor, coordinator, { root = defaultRoot(), delegation,
  socketPath = process.env.HERDR_SOCKET_PATH, paneId = process.env.HERDR_PANE_ID } = {}) {
  const report = diagnostics('management');
  pi.registerTool({
    name: 'continuation_delivery_preferences', label: 'Assignment delivery preferences',
    description: 'Read current human-set delivery preferences for this exact coordinating owner, subject to repository and assignment rules. Choices never grant Git publication.',
    parameters: Type.Object({}),
    async execute(_call, _args, _signal, _update, ctx) {
      const view = await managementSnapshot(root, socketPath, ctx);
      const owner = view.own;
      if (!owner?.current || owner.binding.role !== 'owner')
        refuse('Exact supervised coordinating owner required for delivery preferences');
      const grant = await readJson(join(root, `delegation-${owner.binding.coordinatorId}.json`));
      if (!grant.ownerLaunch || grant.id !== owner.binding.coordinatorId)
        refuse('Exact owner assignment unavailable');
      const effective = await readAssignmentDeliveryPreferences(root, grant);
      return { content: [{ type: 'text', text: deliveryFields.map(field =>
        `${field.label}: ${effective[field.key]}`).join('\n') +
        `\n${reviewFixPreferenceGuidance} These settings do not grant publication.` }],
      details: { grantId: grant.id, effective } };
    },
  });
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
      const editPreferences = async (title, saved, save) => {
        const draft = { ...saved };
        while (true) {
          const rows = deliveryFields.map(field => `${field.label}: ${draft[field.key]}`);
          const choice = await select(`${title}\nRepository rules and human decisions still apply.`,
            [...rows, 'Save', 'Cancel']);
          if (!choice || choice === 'Cancel') return;
          if (choice === 'Save') {
            if (!current()) refuse('Session changed before saving delivery preferences');
            await save(draft);
            ctx.ui.notify('Delivery preferences saved', 'info');
            return;
          }
          const field = deliveryFields[rows.indexOf(choice)];
          if (!field) refuse('Delivery preference selection changed');
          const selected = await select(`${field.label} · ${draft[field.key]}` +
            (field.key === 'fixReviewFindings' ? '\nHuman-selection rules and existing waits still apply.' : ''),
            [...field.choices, 'Back']);
          if (field.choices.includes(selected)) draft[field.key] = selected;
        }
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
        const rows = view.workers.filter(row => !row.binding.stopped && row.current);
        const previous = view.workers.filter(row => !row.binding.stopped && !row.current);
        const labels = rows.map((row, index) => `${index + 1}. ${row.name} — ${row.status.label}`);
        const previousChoice = `Previous / unavailable registrations (${previous.length})`;
        const canRecoverReviewers = view.running && view.own?.current && view.own.binding.role === 'owner' &&
          await delegation?.canRecoverReviewers(ctx);
        if (!current()) refuse('Session changed while reading supervision');
        const choices = ['Delivery preferences',
          ...(view.own?.binding.role === 'owner' ? ['This assignment: delivery'] : []),
          ...(canRecoverReviewers ? ['Restore read-only reviewer delegation'] : []),
          ...(view.own ? ['This session: details'] : []),
          ...(view.own?.current && ['idle', 'done'].includes(view.own.agent?.agent_status) &&
            worker.hold && view.own.observation?.hold ? ['Clear this session hold'] : []),
          ...(view.own?.current && ['idle', 'done'].includes(view.own.agent?.agent_status) &&
            view.own.binding.role === 'owner' &&
            view.state.ownerWaits?.[view.own.binding.workerId]?.kind === 'user' ?
            [...(view.state.ownerWaits[view.own.binding.workerId].id &&
              !view.state.ownerWaits[view.own.binding.workerId].decisionId ? ['Submit owner decision'] : []),
            ...(!view.state.ownerWaits[view.own.binding.workerId].decisionId ? ['Release this owner decision wait'] : [])] : []),
          ...(supervisor.active ? ['Pause global supervision', 'Start global supervision'] :
            view.running ? [view.own ? 'Return this session to supervision' : 'Join this session to supervision'] : ['Start supervisor here']),
          ...labels, ...(previous.length ? [previousChoice] : []), 'Close'];
        const title = `Continuation · ${here}${view.running ? '' : ' · supervisor unavailable'}`;
        const choice = await select(`${title}\nCurrent workers (${rows.length})`, choices);
        if (!choice || choice === 'Close') return;
        if (choice === 'Delivery preferences')
          return editPreferences('Delivery preferences · defaults for new assignments',
            await readDeliveryPreferences(root), draft => saveDeliveryPreferences(root, draft));
        if (choice === 'Clear this session hold') {
          await freshView(view.own);
          return worker.clearHold(ctx);
        }
        if (choice === 'Submit owner decision') {
          await freshView(view.own);
          return coordinator.submitDecision(ctx);
        }
        if (choice === 'Release this owner decision wait') {
          const fresh = await freshView(view.own);
          if (fresh.state.ownerWaits?.[view.own.binding.workerId]?.kind !== 'user')
            refuse('Owner decision changed; reopen the management menu');
          return coordinator.releaseDecision(ctx);
        }
        if (choice === 'Restore read-only reviewer delegation' && canRecoverReviewers) {
          await freshView(view.own);
          return await delegation.recoverReviewers(ctx);
        }
        if (choice === 'This assignment: delivery') {
          const path = join(root, `delegation-${view.own.binding.coordinatorId}.json`);
          const grant = await readJson(path);
          if (!grant.ownerLaunch || grant.id !== view.own.binding.coordinatorId)
            refuse('Exact owner assignment unavailable');
          const previous = await readAssignmentDeliveryPreferences(root, grant);
          return editPreferences('This assignment · delivery preferences', previous, async draft => {
            await freshView(view.own);
            const latest = await readJson(path);
            if (latest.revoked || !unchanged(latest, grant))
              refuse('Assignment changed; reopen delivery preferences');
            await saveAssignmentDeliveryPreferences(root, grant.id, draft);
          });
        }
        await freshView();
        if (choice === 'Pause global supervision') return supervisor.command('pause global', ctx);
        if (choice === 'Start global supervision' || choice === 'Start supervisor here') return supervisor.command('start', ctx);
        if (choice === 'Return this session to supervision' || choice === 'Join this session to supervision') return worker.start(ctx);
        let row = choice === 'This session: details' ? view.own : rows[labels.indexOf(choice)];
        const inspectingPrevious = choice === previousChoice;
        if (inspectingPrevious) {
          const previousLabels = previous.map((item, index) => `${index + 1}. ${item.name} — ${item.status.label}`);
          const selected = await select('Previous / unavailable registrations', [...previousLabels, 'Close']);
          if (!selected || selected === 'Close') return;
          row = previous[previousLabels.indexOf(selected)];
        }
        if (!row) return;
        const fresh = await freshView(row);
        const selected = fresh.workers.find(w => w.binding.workerId === row.binding.workerId);
        const canControl = !inspectingPrevious && view.running && !row.binding.stopped && sameOccupant(selected.agent, row.binding);
        const canReturn = !inspectingPrevious && row === view.own && view.running;
        const action = await select(`${selected.name} · ${selected.status.label}`, ['Details',
          ...(canControl ? ['Pause this worker', 'Stop supervising this worker'] : []),
          ...(canReturn ? ['Return this session to supervision'] : []), 'Close']);
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
