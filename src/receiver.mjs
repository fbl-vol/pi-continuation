import { join } from 'node:path';
import { readJson, atomicJson, claim } from './store.mjs';
import { currentSession } from './session.mjs';
import { listenJson, ownerAlive } from './ipc.mjs';
import { readSupervisor, readObservation, isId } from './contracts.mjs';
import { diagnostics } from './diagnostics.mjs';

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
  const state = await readSupervisor(root);
  const owner = await readJson(join(root, 'supervisor.lock'));
  const binding = state.workers?.[worker.workerId];
  const observation = await readObservation(root, worker.workerId);
  const intent = await readJson(join(root, `intent-${action.id}.json`));
  const session = currentSession(ctx);
  const version = stopVersion();
  if (observation.version !== version || isHeld() || !await ownerAlive(root, owner.token))
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
  if (latest.paused || latest.routes?.[binding.route]?.paused !== false ||
      latest.workers?.[worker.workerId]?.paused !== false || latest.ownerToken !== owner.token ||
      !ctx.isIdle() || isHeld() || stopVersion() !== version || currentSession(ctx).leaf !== session.leaf) {
    return { accepted: false, reason: 'session changed after receipt' };
  }
  pi.sendMessage({ customType: 'pi-continuation',
    content: `Continue the already approved assignment from your existing checkpoint. Do not bypass pauses, approvals, or review requirements. Action ${action.id}.`,
    display: true }, { triggerTurn: true });
  await atomicJson(join(root, `receipt-${action.id}.json`), { id: action.id, status: 'sent' });
  return { accepted: true, id: action.id };
}
