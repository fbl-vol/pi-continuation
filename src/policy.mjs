import { createHash } from 'node:crypto';

// Deterministic policy and transitions only: no Pi, transport, storage or clocks.
// The workflow owns when a transition is persisted relative to an external effect.
export function checkpointComplete(checkpoint) {
  return /^\s*State:\s*(?:backlog empty|completed)\s*$/im.test(checkpoint);
}

function existingNotice(state, workerId, stop, kind) {
  return Object.values(state.notices).find(n => n.workerId === workerId && n.stop === stop && n.kind === kind);
}

export function planDisposition(state, args, checkpoint) {
  const reject = message => ({ kind: 'reject', message });
  if (!checkpoint.trim()) return reject('Empty checkpoint; hold');
  const evidence = args.evidence.trim();
  if (!checkpoint.includes(evidence)) return reject('Evidence is absent from the current checkpoint');
  const worker = state.workers[args.workerId];
  if (args.action === 'notify') {
    if (!args.kind || !state.routes[worker.route]?.coordinator)
      return reject('Material kind and exact coordinator binding required');
    if (args.kind === 'completion' && !checkpointComplete(checkpoint))
      return reject('Whole-assignment completion is not evidenced in checkpoint');
    const existing = existingNotice(state, args.workerId, args.stop, args.kind);
    if (existing) return reject(`Notice already ${existing.status}`);
    return { kind: 'notify', notice: { workerId: args.workerId, stop: args.stop,
      kind: args.kind, text: evidence, route: worker.route } };
  }
  if (args.action === 'pause') return { kind: 'pause' };
  if (args.action === 'acknowledge') {
    return checkpointComplete(checkpoint) ? { kind: 'acknowledge' } :
      reject('Checkpoint does not report whole-assignment completion');
  }
  const previous = state.budgets[args.workerId];
  const hash = createHash('sha256').update(checkpoint).digest('hex');
  const newResult = previous && previous.hash !== hash && !previous.checkpoint?.includes(evidence);
  const count = newResult ? 0 : previous?.count ?? 0;
  if (count >= 2) return { kind: 'budget-exhausted', reason: 'Two nudges without evidenced progress' };
  return { kind: 'resume', budget: { count: count + 1, hash, checkpoint } };
}

export function recordDisposition(state, workerId, stop, action) {
  state.handled[workerId] = stop;
  state.dispositions[workerId] = { stop, action };
  if (['pause', 'blocker', 'decision'].includes(action)) state.workers[workerId].paused = true;
  // A later notice must never clear a successful delivery's no-resend guard.
}

export function addNotice(state, notice) {
  const existing = notice.stop && existingNotice(state, notice.workerId, notice.stop, notice.kind);
  if (existing) return existing;
  const saved = { ...notice, status: 'pending' };
  state.notices[notice.id] = saved;
  return saved;
}

export function prepareResume(state, workerId, stop, id) {
  state.inflight[workerId] = { id, stop };
  return { id, workerId, stop, ownerToken: state.ownerToken, status: 'sending' };
}

export function confirmResume(state, intent, budget) {
  recordDisposition(state, intent.workerId, intent.stop, 'resume');
  state.resumed[intent.workerId] = intent.stop;
  delete state.inflight[intent.workerId];
  state.budgets[intent.workerId] = budget;
}

export function resolveResume(state, workerId) {
  const intent = state.inflight[workerId];
  state.handled[workerId] = intent.stop;
  state.resumed[workerId] = intent.stop;
  delete state.inflight[workerId];
}

// Called only after a human confirms changing this scope. No other pause is lifted.
export function setScopePaused(state, kind, id, paused) {
  const target = kind === 'global' ? state : kind === 'route' ? state.routes[id] : state.workers[id];
  if (!paused && target.paused && kind === 'worker') {
    delete state.repair[id];
    const disposition = state.dispositions[id];
    if (disposition && disposition.stop === state.handled[id] &&
        ['pause', 'blocker', 'decision'].includes(disposition.action)) delete state.handled[id];
  }
  target.paused = paused;
}

export function recoverUncertain(state) {
  for (const workerId of Object.keys(state.inflight)) {
    if (state.workers[workerId]) state.workers[workerId].paused = true;
  }
  for (const notice of Object.values(state.notices)) {
    if (notice.status === 'sending') {
      state.routes[notice.route].paused = true;
      notice.status = 'uncertain';
    }
  }
}

export function recordUnresolvedAttention(state, workerId, stop, noticeId) {
  const prior = state.repair[workerId];
  if (prior?.stop !== stop) state.repair[workerId] = { stop, count: 0 };
  else if (prior.count < 1) prior.count++;
  else {
    const worker = state.workers[workerId];
    worker.paused = true;
    prior.failure = 'Unresolved after corrective wake';
    if (state.routes[worker.route]?.coordinator && !prior.noticeId) {
      const notice = addNotice(state, { id: noticeId, workerId, stop, kind: 'blocker',
        text: 'Continuation disposition unresolved after corrective wake', route: worker.route });
      prior.noticeId = notice.id;
    }
  }
}
