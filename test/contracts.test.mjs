import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeSupervisor, decodeObservation, newSupervisor, MAX_FINAL_REPLY_BYTES } from '../src/contracts.mjs';

test('legacy normalization preserves pauses, pending work and conservative no-resend guards without rewriting input', () => {
  const legacy = { paused: true, workers: { w: { route: 'r', paused: true } },
    routes: { r: { paused: true } }, handled: { w: 'old-stop' },
    inflight: { w: { id: 'action', stop: 'uncertain-stop' } }, budgets: { w: { count: 2, hash: 'old-hash' } } };
  const saved = structuredClone(legacy);
  const state = decodeSupervisor(legacy);
  assert.equal(state.schemaVersion, 1);
  assert.deepEqual(state.resumed, { w: 'old-stop' });
  assert.deepEqual(state.inflight, saved.inflight);
  assert.equal(state.budgets.w.count, 2);
  assert.equal(state.workers.w.paused, true);
  assert.equal(state.routes.r.paused, true);
  assert.deepEqual(legacy, saved);
  assert.deepEqual(decodeSupervisor(state), state);
});

test('unknown versions and malformed authority fields fail instead of acquiring defaults', () => {
  for (const patch of [{ schemaVersion: 2 }, { paused: 'false' }, { workers: [] },
    { routes: { r: { paused: null } } }, { resumed: null },
    { budgets: { w: { count: -1, hash: 'h' } } }, { inflight: { w: {} } }]) {
    assert.throws(() => decodeSupervisor({ ...newSupervisor(), ...patch }),
      error => ['UNSUPPORTED_FORMAT', 'INVALID_RECORD'].includes(error.code));
  }
  assert.throws(() => decodeSupervisor({ schemaVersion: 1, paused: false, routes: {}, workers: {} }),
    { code: 'INVALID_RECORD' });
});

test('old completion notices remain readable, but malformed report hashes cannot be persisted', () => {
  const state = newSupervisor();
  state.routes.r = { paused: false };
  state.notices.n = { id: 'n', workerId: 'w', route: 'r', kind: 'completion',
    text: 'Review finished', status: 'pending' };
  assert.deepEqual(decodeSupervisor(state).notices.n, state.notices.n);
  state.notices.n.reportHash = 'invalid';
  assert.throws(() => decodeSupervisor(state), { code: 'INVALID_RECORD' });
  state.notices.n.reportHash = 'a'.repeat(64);
  assert.deepEqual(decodeSupervisor(state).notices.n, state.notices.n);
});

test('a completed stop without a bounded final reply is held for inspection', () => {
  const stop = { schemaVersion: 1, outcome: 'completed', stop: 'stop', version: 1,
    session: { id: 's', file: '/session' }, hold: false };
  assert.equal(decodeObservation(stop).hold, true);
  assert.equal(decodeObservation({ ...stop, finalReply: 'Can I deploy?' }).hold, false);
  assert.equal(decodeObservation({ ...stop, finalReply: '  ' }).hold, true);
  assert.throws(() => decodeObservation({ ...stop, finalReply: 'é'.repeat(MAX_FINAL_REPLY_BYTES) }),
    { code: 'INVALID_RECORD' });
  assert.throws(() => decodeObservation({ ...stop, finalReply: 42 }), { code: 'INVALID_RECORD' });
  assert.throws(() => decodeObservation({ ...stop, bootstrapPending: 'yes' }), { code: 'INVALID_RECORD' });
  assert.equal(decodeObservation({ ...stop, finalReply: 'Progress', bootstrapPending: true }).hold, true);
});

test('optional prompt scope stamps preserve legacy records but reject malformed identity or revision', () => {
  const record = { schemaVersion: 1, outcome: 'unknown', stop: null, version: 1,
    session: { id: 's', file: '/session' }, hold: false };
  assert.equal(decodeObservation(record).promptScope, undefined);
  const stamp = { id: 'd520bc3f-2318-48de-a544-9e3c49ac9067', revision: 0 };
  assert.deepEqual(decodeObservation({ ...record, promptScope: stamp }).promptScope, stamp);
  for (const promptScope of [null, { ...stamp, id: 'invalid' }, { ...stamp, revision: -1 },
    { ...stamp, revision: Number.MAX_SAFE_INTEGER + 1 }]) {
    assert.throws(() => decodeObservation({ ...record, promptScope }), { code: 'INVALID_RECORD' });
  }
});

test('observation decoding never invents a generation or clears a legacy hold', () => {
  const old = { outcome: 'working', stop: null, session: { id: 's', file: '/session' } };
  const decoded = decodeObservation(old);
  assert.equal(decoded.hold, true);
  assert.equal(decoded.version, undefined);
  assert.equal(decodeObservation({ ...old, hold: false, version: 4, schemaVersion: 1 }).hold, false);
  assert.equal(decodeObservation({ ...old, outcome: 'aborted', hold: false }).hold, true);
  assert.throws(() => decodeObservation({ ...old, schemaVersion: 1 }), { code: 'INVALID_RECORD' });
  assert.throws(() => decodeObservation({ ...old, schemaVersion: 2 }), { code: 'UNSUPPORTED_FORMAT' });
});
