import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newSupervisor } from '../src/contracts.mjs';
import { checkpointHash, planDisposition, recordDisposition, prepareResume, confirmResume, setScopePaused,
  recoverUncertain, recordUnresolvedAttention } from '../src/policy.mjs';

function state() {
  return { ...newSupervisor(), ownerToken: 'owner', workers: { w: { route: 'r', paused: false } },
    routes: { r: { paused: true, coordinator: { id: 'c' } } } };
}
const resume = { workerId: 'w', stop: 'stop-1', action: 'resume', evidence: 'Result one' };

test('budgets change only on confirmed delivery; formatting is not progress and new cited evidence is', () => {
  const s = state();
  const first = planDisposition(s, resume, 'Result one');
  const intent = prepareResume(s, 'w', 'stop-1', 'action');
  assert.deepEqual(s.budgets, {});
  assert.deepEqual(s.resumed, {});
  assert.deepEqual(s.inflight.w, { id: 'action', stop: 'stop-1' });
  confirmResume(s, intent, first.budget);
  assert.equal(s.budgets.w.count, 1);
  assert.equal(s.resumed.w, 'stop-1');
  assert.equal(s.inflight.w, undefined);
  const second = planDisposition(s, resume, 'Result one\n');
  assert.equal(second.budget.count, 2);
  confirmResume(s, { workerId: 'w', stop: 'stop-2' }, second.budget);
  assert.equal(planDisposition(s, resume, 'Result one\n\n').kind, 'budget-exhausted');
  assert.equal(planDisposition(s, { ...resume, evidence: 'Result two' }, 'Result one\nResult two').budget.count, 1);
});

test('narrative completion requires an exact cited report and current hash for either disposition', () => {
  assert.equal(checkpointHash('abc'),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  const s = state();
  const report = '# Work report\nReviewed the assigned changes\nAll follow-up items closed';
  for (const action of ['acknowledge', 'notify']) {
    const args = { ...resume, action, kind: 'completion' };
    assert.equal(planDisposition(s, args, report).kind, 'reject');
    assert.equal(planDisposition(s, { ...args, reportHash: checkpointHash(report + '\n') }, report).kind,
      'reject');
    assert.equal(planDisposition(s, { ...args, reportHash: checkpointHash(report),
      evidence: 'Old result' }, report).kind, 'reject');
    const result = planDisposition(s, { ...args, reportHash: checkpointHash(report),
      evidence: 'All follow-up items closed' }, report);
    assert.equal(result.kind, action);
    if (action === 'notify') assert.equal(result.notice.reportHash, checkpointHash(report));
  }
});

test('a prose-only approval can justify a decision but never a resume or completion', () => {
  const s = state();
  const reply = 'Progress is ready. Can I deploy to production?';
  const checkpoint = 'Progress is ready; deployment awaits a user decision.';
  const evidence = 'Can I deploy to production?';
  assert.equal(planDisposition(s, { ...resume, action: 'notify', kind: 'decision', evidence },
    checkpoint, reply).notice.text, evidence);
  assert.equal(planDisposition(s, { ...resume, action: 'pause', evidence }, checkpoint, reply).kind, 'pause');
  assert.equal(planDisposition(s, { ...resume, action: 'notify', kind: 'decision', evidence },
    '', reply).notice.text, evidence);
  assert.equal(planDisposition(s, { ...resume, evidence }, checkpoint, reply).kind, 'reject');
  assert.equal(planDisposition(s, { ...resume, action: 'notify', kind: 'completion', evidence,
    reportHash: checkpointHash(checkpoint) }, checkpoint, reply).kind, 'reject');
});

test('human rearming preserves other pauses, budgets and successful delivery guards', () => {
  const s = state();
  s.budgets.w = { count: 2, hash: 'h' };
  s.resumed.w = 'stop-1';
  recordDisposition(s, 'w', 'stop-1', 'decision');
  s.repair.w = { stop: 'stop-1', count: 1 };
  setScopePaused(s, 'worker', 'w', false);
  assert.equal(s.workers.w.paused, false);
  assert.equal(s.handled.w, undefined);
  assert.equal(s.repair.w, undefined);
  assert.equal(s.resumed.w, 'stop-1');
  assert.equal(s.budgets.w.count, 2);
  assert.equal(s.paused, true);
  assert.equal(s.routes.r.paused, true);
});

test('recovery and unresolved-attention transitions suspend only their recorded scopes', () => {
  const s = state();
  s.workers.other = { route: 'other', paused: false };
  s.routes.other = { paused: false };
  s.inflight.w = { id: 'a', stop: 's' };
  recoverUncertain(s);
  assert.equal(s.workers.w.paused, true);
  assert.equal(s.workers.other.paused, false);
  recordUnresolvedAttention(s, 'w', 's', 'n0');
  recordUnresolvedAttention(s, 'w', 's', 'n1');
  assert.deepEqual(s.notices, {});
  recordUnresolvedAttention(s, 'w', 's', 'n2');
  recordUnresolvedAttention(s, 'w', 's', 'n3');
  assert.deepEqual(Object.keys(s.notices), ['n2']);
  assert.equal(s.notices.n2.kind, 'blocker');
  assert.equal(s.repair.w.noticeId, 'n2');
});
