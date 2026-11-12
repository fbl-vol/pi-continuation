import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomicJson, readJson } from '../src/store.mjs';
import { bindSupervisor } from '../src/supervisor.mjs';
import { endpoint } from '../src/herdr.mjs';
import { prepareHandoff, rollbackHandoff } from '../src/ownership.mjs';

test('human attachment preserves pauses and conservative budget; retired ownership isolates the worker', async t => {
  const temporary = await mkdtemp(join(tmpdir(), 'continuation-handoff-'));
  const root = await realpath(temporary);
  const socketPath = process.platform === 'win32' ? `test-${randomUUID()}` : join(root, 'herdr.sock');
  const subscriptions = new Set();
  const record = { workerId: randomUUID(), sessionId: randomUUID(),
    sessionFile: join(root, 'session.jsonl'), checkpoint: join(root, 'checkpoint.md'),
    cwd: '/project', paneId: 'w1:p1' };
  const stop = randomUUID();
  const agent = { pane_id: record.paneId, tab_id: 'w1:t1', workspace_id: 'w1', terminal_id: 'terminal',
    cwd: record.cwd, agent: 'pi', agent_status: 'idle', completion_seq: 1,
    agent_session: { source: 'herdr:pi', agent: 'pi', kind: 'path', value: record.sessionFile } };
  const herdr = net.createServer(socket => socket.once('data', data => {
    const request = JSON.parse(data);
    if (request.method === 'events.subscribe') {
      subscriptions.add(socket);
      socket.on('close', () => subscriptions.delete(socket));
      socket.write(JSON.stringify({ id: request.id, result: { type: 'subscription_started' } }) + '\n');
    } else {
      assert.equal(request.method, 'session.snapshot');
      socket.end(JSON.stringify({ id: request.id, result: { type: 'session_snapshot',
        snapshot: { protocol: 22, agents: [agent] } } }) + '\n');
    }
  }));
  const events = new Map();
  const commands = new Map();
  const notices = [];
  const pi = { on: (event, handler) => events.set(event, handler),
    registerCommand: (name, definition) => commands.set(name, definition.handler), registerTool: () => {},
    sendMessage: () => assert.fail('current transferred stop must never be replayed') };
  const ctx = { mode: 'tui', isIdle: () => true,
    sessionManager: { getSessionId: () => randomUUID() },
    ui: { confirm: async () => true, notify: message => notices.push(message) } };
  const original = process.env.HERDR_ENV;
  process.env.HERDR_ENV = '1';
  t.after(async () => {
    await events.get('session_shutdown')?.();
    for (const socket of subscriptions) socket.destroy();
    await new Promise(resolve => herdr.close(resolve));
    await rm(root, { recursive: true, force: true });
    if (original === undefined) delete process.env.HERDR_ENV;
    else process.env.HERDR_ENV = original;
  });
  await writeFile(record.sessionFile, '{}\n');
  await writeFile(record.checkpoint, 'Existing concrete result, unknown old spent budget');
  await atomicJson(join(root, `worker-${record.workerId}.json`), record);
  await atomicJson(join(root, `observation-${record.workerId}.json`), {
    outcome: 'completed', hold: false, stop, version: 0, finalReply: 'Approved work remains.',
    session: { id: record.sessionId, file: record.sessionFile, leaf: 'leaf' },
  });
  await new Promise(resolve => herdr.listen(endpoint(socketPath), resolve));
  const reference = await prepareHandoff(join(root, 'ownership'), {
    identity: { sessionId: record.sessionId, sessionFile: record.sessionFile, checkpoint: record.checkpoint },
    target: { root, workerId: record.workerId },
  }, () => {});
  bindSupervisor(pi, { root, socketPath, allowExperimentalActivation: true });
  const command = args => commands.get('continuation-supervisor')(args, ctx);
  const saved = () => readJson(join(root, 'supervisor.json'));
  await command('init');
  await command(`add ${record.workerId} w1`);
  await assert.rejects(command(`activate worker ${record.workerId}`), /witness exists; attach/);
  assert.equal((await saved()).workers[record.workerId].paused, true);
  await command('handoff ' + JSON.stringify(reference));
  let state = await saved();
  assert.equal(state.paused, true);
  assert.equal(state.routes.w1.paused, true);
  assert.equal(state.workers[record.workerId].paused, true);
  assert.equal(state.workers[record.workerId].handoff.handoffId, reference.handoffId);
  assert.equal(state.resumed[record.workerId], stop);
  assert.equal(state.handled[record.workerId], stop);
  assert.equal(state.budgets[record.workerId].count, 2);
  await assert.rejects(command('handoff ' + JSON.stringify(reference)), /newly bound/);
  await command(`activate worker ${record.workerId}`);
  assert.equal((await saved()).budgets[record.workerId].count, 2);
  await rollbackHandoff(reference, () => {});
  await assert.rejects(command(`activate worker ${record.workerId}`), /not the selected/);
  await command('activate route w1');
  await command('activate global');
  state = await saved();
  assert.equal(state.paused, false);
  assert.equal(state.routes.w1.paused, false);
  assert.equal(state.workers[record.workerId].paused, true);
  assert.equal(state.workers[record.workerId].reason, 'Worker ownership unavailable');
  assert.match(notices.join('\n'), /current stop not replayed/);
});
