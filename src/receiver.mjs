import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { readJson, atomicJson, claim } from './store.mjs';
import { currentSession } from './session.mjs';
import { listenJson, ownerAlive } from './ipc.mjs';
import { ownerDecisionEvidence, readSupervisor, readObservation, isId } from './contracts.mjs';
import { diagnostics } from './diagnostics.mjs';
import { withWorkerHandoff } from './ownership.mjs';
import { spawnPath } from './delegation.mjs';
import { unresolvedDecisionAtStop } from './policy.mjs';

// Never start this listener without an explicitly registered native worker session.
export function receive(root, worker, pi, context, stopVersion, isHeld) {
  const report = diagnostics('worker');
  return listenJson(root, worker.workerId,
    action => accept(root, worker, action, context, pi, stopVersion, isHeld),
    error => report('accept continuation', error, context));
}

export async function accept(root, worker, action, ctx, pi, stopVersion = () => 0,
  isHeld = () => false) {
  if (!action || !isId(action.id)) return { accepted: false, reason: 'invalid action' };
  const initial = await readSupervisor(root);
  const binding = initial.workers?.[worker.workerId];
  try {
    // Conservatively spend rollback eligibility on any addressed delivery attempt,
    // even if later stop/approval checks reject it. Hold the fence through send.
    return await withWorkerHandoff(root, worker.workerId, binding, { effect: true }, () =>
      acceptOwned(root, worker, action, ctx, pi, stopVersion, isHeld, binding?.handoff));
  } catch (error) {
    if (error.code === 'OWNERSHIP_FENCE') return { accepted: false, reason: 'ownership unavailable' };
    throw error;
  }
}

async function currentDecision(root, state, binding, intent, stop) {
  if (intent.type !== 'owner-decision') return true;
  const owner = state.workers[intent.sourceWorkerId];
  const wait = state.ownerWaits[intent.sourceWorkerId];
  return owner?.role === 'owner' && !owner.paused && !state.routes[owner.route]?.paused &&
    binding?.recipient?.id === owner.coordinatorId && binding.recipient.sessionId === owner.sessionId &&
    intent.workerId === binding.workerId && wait?.kind === 'user' && wait.id === intent.id && wait.decisionId === intent.id &&
    !state.inflight[binding.workerId] && !unresolvedDecisionAtStop(state.dispositions[binding.workerId], stop) &&
    isDeepStrictEqual(ownerDecisionEvidence(await readObservation(root, owner.workerId), owner), intent.evidence);
}

async function acceptOwned(root, worker, action, ctx, pi, stopVersion, isHeld, handoff) {
  const state = await readSupervisor(root);
  const owner = await readJson(join(root, 'supervisor.lock'));
  const binding = state.workers?.[worker.workerId];
  const observation = await readObservation(root, worker.workerId);
  const intent = await readJson(join(root, `intent-${action.id}.json`));
  const session = currentSession(ctx);
  const version = stopVersion();
  if (worker.delegationId && (await readJson(spawnPath(root, worker.delegationId))).status !== 'dispatched')
    return { accepted: false, reason: 'delegated assignment requires inspection' };
  if (JSON.stringify(binding?.handoff) !== JSON.stringify(handoff) ||
      observation.version !== version || observation.hold || isHeld() ||
      !await ownerAlive(root, owner.token) || !await currentDecision(root, state, binding, intent, observation.stop))
    return { accepted: false, reason: 'stop changed or supervisor unavailable' };
  // Persist the one-use receipt, then recheck current state and stop generation.
  // The final eligibility check and message injection have no intervening await.
  if (ctx.mode !== 'tui' || !ctx.isIdle() || owner.token !== state.ownerToken ||
      owner.token !== action.ownerToken || owner.pid !== state.ownerPid ||
      state.paused ||
      state.routes?.[binding?.route]?.paused !== false || binding?.paused !== false ||
      binding?.sessionId !== worker.sessionId || action.workerId !== worker.workerId ||
      action.id !== intent.id || intent.status !== 'sending' ||
      intent.ownerToken !== owner.token || intent.stop !== action.stop ||
      observation.outcome !== 'completed' || observation.stop !== action.stop ||
      observation.session.id !== session.id || observation.session.file !== session.file ||
      observation.session.leaf !== session.leaf || session.id !== worker.sessionId ||
      session.file !== worker.sessionFile) {
    return { accepted: false, reason: 'stale or paused' };
  }
  // A crash between receipt persistence and send is ambiguous: the supervisor
  // must suspend and inspect rather than repeat this action.
  try { await claim(join(root, `receipt-${action.id}.json`), { id: action.id, status: 'accepted' }); }
  catch (error) {
    if (error.code === 'EEXIST') return { accepted: false, reason: 'duplicate action' };
    throw error;
  }
  const latest = await readSupervisor(root);
  const latestObservation = await readObservation(root, worker.workerId);
  const delegatedReady = !worker.delegationId ||
    (await readJson(spawnPath(root, worker.delegationId))).status === 'dispatched';
  if (!delegatedReady || !await currentDecision(root, latest, latest.workers[worker.workerId], intent, latestObservation.stop) ||
      JSON.stringify(latest.workers?.[worker.workerId]?.handoff) !== JSON.stringify(handoff) ||
      latest.paused || latest.routes?.[binding.route]?.paused !== false ||
      latest.workers?.[worker.workerId]?.paused !== false || latest.ownerToken !== owner.token ||
      latestObservation.hold || latestObservation.version !== version ||
      latestObservation.stop !== action.stop || latestObservation.session.id !== session.id ||
      latestObservation.session.file !== session.file || latestObservation.session.leaf !== session.leaf ||
      !ctx.isIdle() || currentSession(ctx).leaf !== session.leaf || isHeld() || stopVersion() !== version) {
    return { accepted: false, reason: 'session changed after receipt' };
  }
  const content = intent.type === 'owner-decision' ?
    `Decision submitted in your exact coordinating owner pane (action ${action.id}). Apply only the selected scope within the existing assignment. ` +
    `Do not infer missing selections or bypass independent review. If the selection is unclear, report it without editing.\n\n${intent.answer}` :
    `Continue the already approved assignment from your existing checkpoint. Do not bypass pauses, approvals, or review requirements. Action ${action.id}.`;
  pi.sendMessage({ customType: 'pi-continuation',
    content,
    display: true }, { triggerTurn: true });
  await atomicJson(join(root, `receipt-${action.id}.json`), { id: action.id, status: 'sent' });
  return { accepted: true, id: action.id };
}
