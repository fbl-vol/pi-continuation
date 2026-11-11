import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomicJson, readJson } from '../src/store.mjs';
import { accept, workerEndpoint } from '../src/receiver.mjs';

test('Windows pipe names are deterministic per private root and do not embed filesystem separators', () => {
  const a = workerEndpoint('C:\\Users\\Name With Spaces\\ü', 'worker', 'win32');
  assert.ok(a.startsWith('\\\\.\\pipe\\pi-continuation-'));
  assert.match(a.slice('\\\\.\\pipe\\pi-continuation-'.length), /^[a-f0-9]{16}-worker$/);
  assert.notEqual(a, workerEndpoint('C:\\Users\\Other', 'worker', 'win32'));
  assert.equal(a, workerEndpoint('C:\\Users\\Name With Spaces\\ü', 'worker', 'win32'));
});

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'continuation-'));
  const worker = { workerId: randomUUID(), sessionId: 'session-1', sessionFile: '/sessions/session-1.jsonl' };
  const token = randomUUID();
  const action = { id: randomUUID(), ownerToken: token, workerId: worker.workerId, stop: randomUUID() };
  const state = { paused: false, ownerToken: token, ownerPid: process.pid, routes: { w1: { paused: false } },
    workers: { [worker.workerId]: { route: 'w1', paused: false, sessionId: worker.sessionId } } };
  const observation = { outcome: 'completed', stop: action.stop, version: 0,
    session: { id: worker.sessionId, file: worker.sessionFile, leaf: 'leaf-1' } };
  const persist = (name, value) => atomicJson(join(root, name), value);
  await persist('supervisor.json', state);
  await persist('supervisor.lock', { token, pid: process.pid });
  await persist(`observation-${worker.workerId}.json`, observation);
  await persist(`intent-${action.id}.json`, { ...action, status: 'sending' });
  const owner = net.createServer(socket => socket.once('data', data => socket.end(data)));
  await new Promise(resolve => owner.listen(workerEndpoint(root, 'supervisor'), resolve));
  let version = 0;
  let idle = true;
  const sent = [];
  const pi = { sendMessage: (...args) => sent.push(args) };
  const ctx = { mode: 'tui', isIdle: () => idle, sessionManager: {
    getSessionId: () => worker.sessionId, getSessionFile: () => worker.sessionFile,
    getLeafId: () => 'leaf-1',
  } };
  return { root, worker, action, observation, persist, state, owner, pi, ctx, sent,
    version: () => version, interrupt: () => { version++; }, busy: () => { idle = false; },
    close: async () => { if (owner.listening) await new Promise(resolve => owner.close(resolve));
      await rm(root, { recursive: true, force: true }); } };
}

test('exact stop accepted once; duplicate send cannot start another turn', async () => {
  const s = await setup();
  try {
    const first = await accept(s.root, s.worker, s.action, s.ctx, s.pi, s.version);
    assert.deepEqual(first, { accepted: true, id: s.action.id });
    assert.equal(s.sent.length, 1);
    const repeated = await accept(s.root, s.worker, s.action, s.ctx, s.pi, s.version);
    assert.equal(repeated.accepted, false);
    assert.equal(s.sent.length, 1);
  } finally { await s.close(); }
});

test('approval hold opening after persisted receipt rejects injection', async () => {
  const s = await setup();
  try {
    let held = false;
    let checks = 0;
    s.ctx.isIdle = () => { if (++checks === 2) held = true; return true; };
    const result = await accept(s.root, s.worker, s.action, s.ctx, s.pi, s.version, () => held);
    assert.equal(result.accepted, false);
    assert.equal((await readJson(join(s.root, `receipt-${s.action.id}.json`))).status, 'accepted');
    assert.deepEqual(s.sent, []);
  } finally { await s.close(); }
});

test('human input begun before receipt cannot inherit a prior stop', async () => {
  const s = await setup();
  try {
    s.interrupt();
    assert.equal((await accept(s.root, s.worker, s.action, s.ctx, s.pi, s.version)).accepted, false);
    assert.deepEqual(s.sent, []);
  } finally { await s.close(); }
});

test('new human input after persisted receipt invalidates delivery', async () => {
  const s = await setup();
  try {
    let checks = 0;
    s.ctx.isIdle = () => { if (++checks === 2) s.interrupt(); return true; };
    const result = await accept(s.root, s.worker, s.action, s.ctx, s.pi, s.version);
    assert.equal(result.accepted, false);
    assert.equal((await readJson(join(s.root, `receipt-${s.action.id}.json`))).status, 'accepted');
    assert.deepEqual(s.sent, []);
  } finally { await s.close(); }
});

test('stale stop, pause and unavailable owner never deliver', async () => {
  const s = await setup();
  try {
    await s.persist(`observation-${s.worker.workerId}.json`, { ...s.observation, stop: randomUUID() });
    assert.equal((await accept(s.root, s.worker, s.action, s.ctx, s.pi, s.version)).accepted, false);
    await s.persist(`observation-${s.worker.workerId}.json`, { ...s.observation, outcome: 'approval' });
    assert.equal((await accept(s.root, s.worker, s.action, s.ctx, s.pi, s.version)).accepted, false);
    await s.persist(`observation-${s.worker.workerId}.json`, s.observation);
    s.state.routes.w1.paused = true;
    await s.persist('supervisor.json', s.state);
    assert.equal((await accept(s.root, s.worker, s.action, s.ctx, s.pi, s.version)).accepted, false);
    s.state.routes.w1.paused = false;
    await s.persist('supervisor.json', s.state);
    await new Promise(resolve => s.owner.close(resolve));
    assert.equal((await accept(s.root, s.worker, s.action, s.ctx, s.pi, s.version)).accepted, false);
    assert.deepEqual(s.sent, []);
  } finally { await s.close(); }
});
