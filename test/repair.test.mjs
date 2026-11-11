import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomicJson, readJson } from '../src/store.mjs';
import { bindSupervisor } from '../src/supervisor.mjs';
import { endpoint } from '../src/herdr.mjs';

const waitFor = async predicate => {
  for (let index = 0; index < 100; index++) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('Expected event was not observed');
};

test('one corrective wake then only the unresolved worker is suspended', async () => {
  const root = await mkdtemp(join(tmpdir(), 'continuation-'));
  const socketPath = process.platform === 'win32' ? `test-${randomUUID()}` : join(root, 'herdr.sock');
  const workerId = randomUUID();
  const sessionFile = '/sessions/repair.jsonl';
  const crashedWorker = randomUUID();
  const pendingAction = randomUUID();
  const checkpoint = join(root, 'checkpoint.md');
  const agent = { pane_id: 'w1:p1', workspace_id: 'w1', tab_id: 'w1:t1', terminal_id: 'terminal',
    cwd: '/project', agent: 'pi', agent_status: 'idle', completion_seq: 1,
    agent_session: { source: 'herdr:pi', agent: 'pi', kind: 'path', value: sessionFile } };
  const herdr = net.createServer(socket => socket.once('data', data => {
    const request = JSON.parse(data.toString());
    socket.write(JSON.stringify({ id: request.id, result: request.method === 'events.subscribe' ?
      { type: 'subscription_started' } : { type: 'session_snapshot',
        snapshot: { protocol: 22, agents: [agent] } } }) + '\n');
  }));
  const handlers = new Map();
  const messages = [];
  const pi = { on: (event, fn) => handlers.set(event, fn),
    registerCommand: (_name, definition) => { pi.command = definition.handler; },
    registerTool: () => {}, sendMessage: (...args) => messages.push(args) };
  const ctx = { mode: 'tui', isIdle: () => true,
    sessionManager: { getSessionId: () => 'supervisor' },
    ui: { confirm: async () => true, notify: () => {} } };
  const previous = process.env.HERDR_ENV;
  process.env.HERDR_ENV = '1';
  try {
    await writeFile(checkpoint, 'State: in progress');
    await atomicJson(join(root, `worker-${workerId}.json`), {
      workerId, paneId: agent.pane_id, sessionId: 'native', sessionFile, checkpoint, cwd: agent.cwd,
    });
    await atomicJson(join(root, `observation-${workerId}.json`), {
      stop: randomUUID(), outcome: 'completed', session: { id: 'native', file: sessionFile, leaf: 'leaf' },
    });
    await atomicJson(join(root, 'supervisor.json'), { paused: false, routes: { w1: { paused: false } },
      workers: { [workerId]: { workerId, route: 'w1', paneId: agent.pane_id,
        sessionId: 'native', sessionFile, checkpoint: await realpath(checkpoint),
        cwd: agent.cwd, terminalId: agent.terminal_id,
        workspaceId: agent.workspace_id, tabId: agent.tab_id,
        sessionKind: 'path', sessionValue: sessionFile, paused: false },
        [crashedWorker]: { route: 'w1', paused: false, paneId: 'w1:p9', sessionId: 'other' } },
      handled: {}, inflight: { [crashedWorker]: { id: pendingAction, stop: randomUUID() } } });
    await new Promise(resolve => herdr.listen(endpoint(socketPath), resolve));
    bindSupervisor(pi, { root, socketPath, allowExperimentalActivation: true });
    await pi.command('init', ctx);
    await waitFor(() => messages.length === 1);
    assert.equal((await readJson(join(root, 'supervisor.json'))).workers[crashedWorker].paused, true);
    handlers.get('before_agent_start')({ messageType: 'user' });
    handlers.get('agent_settled')({}, ctx);
    assert.equal(messages.length, 1);
    assert.equal((await readJson(join(root, 'supervisor.json'))).repair[workerId].count, 0);
    handlers.get('before_agent_start')({ messageType: 'custom',
      message: { customType: 'pi-continuation-attention' } });
    handlers.get('agent_settled')({}, ctx);
    await waitFor(() => messages.length === 2);
    handlers.get('before_agent_start')({ messageType: 'custom',
      message: { customType: 'pi-continuation-attention' } });
    handlers.get('agent_settled')({}, ctx);
    await waitFor(async () => (await readJson(join(root, 'supervisor.json'))).workers[workerId].paused);
    assert.equal(messages.length, 2);
    const state = await readJson(join(root, 'supervisor.json'));
    assert.equal(state.repair[workerId].failure, 'Unresolved after corrective wake');
    assert.equal(state.routes.w1.paused, false);
    await handlers.get('session_shutdown')();
    await pi.command('init', ctx);
    assert.notEqual((await readJson(join(root, 'supervisor.lock'))).token, state.ownerToken);
  } finally {
    await handlers.get('session_shutdown')?.();
    await new Promise(resolve => herdr.close(resolve));
    await rm(root, { recursive: true, force: true });
    if (previous === undefined) delete process.env.HERDR_ENV;
    else process.env.HERDR_ENV = previous;
  }
});
