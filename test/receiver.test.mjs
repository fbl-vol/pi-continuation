import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomicJson, readJson } from '../src/store.mjs';
import { accept } from '../src/receiver.mjs';
import { guardPromptUI } from '../src/prompt-guard.mjs';
import { workerEndpoint } from '../src/ipc.mjs';
import { prepareHandoff, rollbackHandoff } from '../src/ownership.mjs';

test('Windows pipe names are deterministic per private root and do not embed filesystem separators', () => {
  const a = workerEndpoint('C:\\Users\\Name With Spaces\\ü', 'worker', 'win32');
  assert.ok(a.startsWith('\\\\.\\pipe\\pi-continuation-'));
  assert.match(a.slice('\\\\.\\pipe\\pi-continuation-'.length), /^[a-f0-9]{16}-worker$/);
  assert.notEqual(a, workerEndpoint('C:\\Users\\Other', 'worker', 'win32'));
  assert.equal(a, workerEndpoint('C:\\Users\\Name With Spaces\\ü', 'worker', 'win32'));
});

async function attachTestHandoff(s) {
  const sessionFile = join(s.root, 'session.jsonl');
  const checkpoint = join(s.root, 'checkpoint.md');
  writeFileSync(sessionFile, '{}\n');
  writeFileSync(checkpoint, 'Existing task evidence');
  const handoff = await prepareHandoff(join(s.root, 'ownership'), {
    identity: { sessionId: randomUUID(), sessionFile, checkpoint },
    target: { root: s.root, workerId: s.worker.workerId },
  }, () => {});
  Object.assign(s.worker, { sessionId: handoff.identity.sessionId, sessionFile: handoff.identity.sessionFile });
  Object.assign(s.state.workers[s.worker.workerId], { sessionId: s.worker.sessionId,
    sessionFile: s.worker.sessionFile, checkpoint: handoff.identity.checkpoint, handoff });
  Object.assign(s.observation.session, { id: s.worker.sessionId, file: s.worker.sessionFile });
  await s.persist('supervisor.json', s.state);
  await s.persist(`observation-${s.worker.workerId}.json`, s.observation);
  return handoff;
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'continuation-'));
  const worker = { workerId: randomUUID(), sessionId: 'session-1', sessionFile: join(root, 'session-1.jsonl') };
  writeFileSync(worker.sessionFile, '{}\n');
  const token = randomUUID();
  const action = { id: randomUUID(), ownerToken: token, workerId: worker.workerId, stop: randomUUID() };
  const state = { paused: false, ownerToken: token, ownerPid: process.pid, routes: { w1: { paused: false } },
    workers: { [worker.workerId]: { route: 'w1', paused: false, sessionId: worker.sessionId,
      sessionFile: worker.sessionFile } } };
  const observation = { outcome: 'completed', stop: action.stop, version: 0, hold: false,
    finalReply: 'Synthetic result: continue the approved task.',
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

test('an unsupported persisted protocol is refused before receipt claim or injection', async () => {
  const s = await setup();
  try {
    await s.persist('supervisor.json', { ...s.state, schemaVersion: 999 });
    await assert.rejects(accept(s.root, s.worker, s.action, s.ctx, s.pi, s.version), { code: 'UNSUPPORTED_FORMAT' });
    assert.deepEqual(s.sent, []);
    await assert.rejects(readJson(join(s.root, `receipt-${s.action.id}.json`)), { code: 'ENOENT' });
  } finally { await s.close(); }
});

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

test('a transferred worker holds the shared fence through injection and cannot roll back afterward', async () => {
  const s = await setup();
  try {
    const handoff = await attachTestHandoff(s);
    let rollback;
    s.pi.sendMessage = (...args) => {
      s.sent.push(args);
      rollback = assert.rejects(rollbackHandoff(handoff,
        () => assert.fail('rollback crossed worker injection')), /worker busy or abandoned lock/);
    };
    assert.equal((await accept(s.root, s.worker, s.action, s.ctx, s.pi, s.version)).accepted, true);
    await rollback;
    assert.equal(s.sent.length, 1);
    await assert.rejects(rollbackHandoff(handoff, () => {}), /unused exact/);
  } finally { await s.close(); }
});

test('omitting handoff attachment cannot inject into a reserved worker or spend rollback eligibility', async () => {
  const s = await setup();
  try {
    const handoff = await attachTestHandoff(s);
    delete s.state.workers[s.worker.workerId].handoff;
    await s.persist('supervisor.json', s.state);
    const result = await accept(s.root, s.worker, s.action, s.ctx, s.pi, s.version);
    assert.equal(result.accepted, false);
    assert.equal(result.reason, 'ownership unavailable');
    assert.deepEqual(s.sent, []);
    await rollbackHandoff(handoff, () => {});
  } finally { await s.close(); }
});

test('returning ownership to the old system fences a persisted active new worker', async () => {
  const s = await setup();
  try {
    const handoff = await attachTestHandoff(s);
    await rollbackHandoff(handoff, () => {});
    const result = await accept(s.root, s.worker, s.action, s.ctx, s.pi, s.version);
    assert.equal(result.accepted, false);
    assert.equal(result.reason, 'ownership unavailable');
    assert.deepEqual(s.sent, []);
    await assert.rejects(readJson(join(s.root, `receipt-${s.action.id}.json`)), { code: 'ENOENT' });
  } finally { await s.close(); }
});

test('a witness cannot authorize a different new worker binding or root', async () => {
  const s = await setup();
  try {
    const handoff = await attachTestHandoff(s);
    handoff.target.workerId = randomUUID();
    await s.persist('supervisor.json', s.state);
    assert.equal((await accept(s.root, s.worker, s.action, s.ctx, s.pi, s.version)).accepted, false);
    assert.deepEqual(s.sent, []);
  } finally { await s.close(); }
});

test('a legacy observation without an explicit cleared hold cannot start a continuation', async () => {
  const s = await setup();
  try {
    const { hold, ...legacy } = s.observation;
    await s.persist(`observation-${s.worker.workerId}.json`, legacy);
    assert.equal((await accept(s.root, s.worker, s.action, s.ctx, s.pi, s.version)).accepted, false);
    assert.deepEqual(s.sent, []);
    await assert.rejects(readJson(join(s.root, `receipt-${s.action.id}.json`)), { code: 'ENOENT' });
  } finally { await s.close(); }
});

test('a completed legacy stop without the worker final reply cannot be resumed', async () => {
  const s = await setup();
  try {
    const { finalReply, ...legacy } = s.observation;
    await s.persist(`observation-${s.worker.workerId}.json`, legacy);
    assert.equal((await accept(s.root, s.worker, s.action, s.ctx, s.pi, s.version)).accepted, false);
    assert.deepEqual(s.sent, []);
    await assert.rejects(readJson(join(s.root, `receipt-${s.action.id}.json`)), { code: 'ENOENT' });
  } finally { await s.close(); }
});

test('a persisted approval hold after the first check blocks delivery after receipt claim', async () => {
  const s = await setup();
  try {
    let checks = 0;
    s.ctx.isIdle = () => {
      if (++checks === 1) writeFileSync(join(s.root, `observation-${s.worker.workerId}.json`),
        JSON.stringify({ ...s.observation, hold: true }));
      return true;
    };
    const result = await accept(s.root, s.worker, s.action, s.ctx, s.pi, s.version);
    assert.equal(result.accepted, false);
    assert.equal((await readJson(join(s.root, `receipt-${s.action.id}.json`))).status, 'accepted');
    assert.deepEqual(s.sent, []);
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

test('a synchronous shared-context prompt at the final receipt check rejects injection before lifecycle delivery', async () => {
  const s = await setup();
  let held = false;
  const ui = Object.fromEntries(['select', 'confirm', 'input', 'editor', 'custom'].map(name =>
    [name, async () => undefined]));
  const guard = guardPromptUI(ui, () => { held = true; });
  let leafReads = 0;
  s.ctx.sessionManager.getLeafId = () => {
    if (++leafReads === 2) void ui.input('Another extension requests approval');
    return 'leaf-1';
  };
  try {
    const result = await accept(s.root, s.worker, s.action, s.ctx, s.pi, s.version,
      () => held || guard.blocked);
    assert.equal(result.accepted, false);
    assert.equal((await readJson(join(s.root, `receipt-${s.action.id}.json`))).status, 'accepted');
    assert.deepEqual(s.sent, []);
  } finally { guard.dispose(); await s.close(); }
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
