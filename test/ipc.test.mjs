import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { listenJson, sendAction, workerEndpoint, ownerServer, ownerAlive } from '../src/ipc.mjs';

test('local framing preserves split UTF-8 and invokes an accepted handler only once', async t => {
  const root = await mkdtemp(join(tmpdir(), 'continuation-'));
  const id = randomUUID();
  const seen = [], failures = [];
  const close = await listenJson(root, id, action => { seen.push(action); return { accepted: true }; }, e => failures.push(e));
  t.after(async () => { await close(); await rm(root, { recursive: true, force: true }); });
  const socket = net.createConnection(workerEndpoint(root, id));
  t.after(() => socket.destroy());
  await once(socket, 'connect');
  const frame = Buffer.from('{"text":"é"}\n{"text":"not a second action"}\n');
  const split = frame.indexOf(Buffer.from('é')) + 1;
  socket.write(frame.subarray(0, split));
  const reply = once(socket, 'data');
  socket.write(frame.subarray(split));
  const [data] = await reply;
  assert.equal(JSON.parse(data.toString()).accepted, true);
  assert.deepEqual(seen, [{ text: 'é' }]);
  assert.deepEqual(failures, []);
});

test('closing drops incomplete peers but drains an accepted handler without retry', { timeout: 5000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'continuation-'));
  const id = randomUUID();
  let enter, finish;
  const entered = new Promise(resolve => { enter = resolve; });
  const release = new Promise(resolve => { finish = resolve; });
  let calls = 0;
  const close = await listenJson(root, id, async action => {
    calls++; enter(); await release;
    return { accepted: true, id: action.id };
  }, error => assert.fail(error));
  t.after(async () => { finish(); await close(); await rm(root, { recursive: true, force: true }); });
  const idle = net.createConnection(workerEndpoint(root, id));
  t.after(() => idle.destroy());
  await once(idle, 'connect');
  idle.write('{');
  const response = sendAction(root, { id: 'a', workerId: id });
  await entered;
  let closed = false;
  const closing = close().then(() => { closed = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(closed, false);
  finish();
  assert.deepEqual(await response, { accepted: true, id: 'a' });
  await closing;
  await close();
  assert.equal(calls, 1);
});

test('native owner challenge does not accept a wrong token and withdraws on close', async () => {
  const root = await mkdtemp(join(tmpdir(), 'continuation-'));
  const token = randomUUID();
  const close = await ownerServer(root, token);
  try {
    assert.equal(await ownerAlive(root, 'wrong'), false);
    assert.equal(await ownerAlive(root, token), true);
    await close();
    assert.equal(await ownerAlive(root, token), false);
  } finally { await close(); await rm(root, { recursive: true, force: true }); }
});
