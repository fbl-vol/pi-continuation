import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomicJson, readJson } from '../src/store.mjs';
import { endpoint } from '../src/herdr.mjs';
import { bindSupervisor } from '../src/supervisor.mjs';
import { bindCoordinator } from '../src/coordinator.mjs';

async function eventually(predicate) {
  for (let i = 0; i < 100; i++) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('Expected state did not arrive');
}

// Real local transport and persistence; only the Pi lifecycle and Herdr server are fake.
async function fixture(t, { coordinatorInput = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'continuation-'));
  const socketPath = process.platform === 'win32' ? `test-${randomUUID()}` : join(root, 'herdr.sock');
  const prior = process.env.HERDR_ENV;
  process.env.HERDR_ENV = '1';
  const agents = [];
  function binding(id, paneId, workspaceId) {
    const sessionFile = `/sessions/${id}.jsonl`;
    const value = { id, paneId, sessionId: id, sessionFile, cwd: '/project',
      terminalId: id, workspaceId, tabId: `${workspaceId}:tab`, sessionKind: 'path', sessionValue: sessionFile };
    agents.push({ agent: 'pi', pane_id: paneId, terminal_id: id, workspace_id: workspaceId,
      tab_id: value.tabId, cwd: value.cwd, agent_status: 'idle', completion_seq: 1,
      agent_session: { source: 'herdr:pi', agent: 'pi', kind: 'path', value: sessionFile } });
    return value;
  }
  const coordinator = binding(randomUUID(), 'c:p1', 'c');
  const worker = { ...binding(randomUUID(), 'w:p1', 'w'), route: 'w', paused: false };
  worker.workerId = worker.id;
  worker.checkpoint = join(root, 'checkpoint.md');
  const stop = randomUUID();
  const observation = { outcome: 'completed', stop, version: 0,
    session: { id: worker.sessionId, file: worker.sessionFile, leaf: 'leaf' } };
  await writeFile(worker.checkpoint, 'State: backlog empty\nValidated result');
  await atomicJson(join(root, `worker-${worker.id}.json`), worker);
  await atomicJson(join(root, `observation-${worker.id}.json`), observation);
  await atomicJson(join(root, `coordinator-${coordinator.id}.json`), coordinator);
  await atomicJson(join(root, 'supervisor.json'), { paused: false,
    workers: { [worker.id]: worker }, routes: { w: { paused: false, coordinator } }, handled: {} });
  const sockets = new Set();
  const subscriptions = new Set();
  const herdr = net.createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => { sockets.delete(socket); subscriptions.delete(socket); });
    socket.once('data', data => {
      const req = JSON.parse(data.toString());
      if (req.method === 'events.subscribe') subscriptions.add(socket);
      socket.write(JSON.stringify({ id: req.id, result: req.method === 'events.subscribe' ?
        { type: 'subscription_started' } : { type: 'session_snapshot', snapshot: { protocol: 22, agents } } }) + '\n');
    });
  });
  const ch = new Map(), sh = new Map();
  const notices = [], wakes = [];
  let command, tool;
  const cctx = { mode: 'tui', isIdle: () => true, sessionManager: {
    getSessionId: () => coordinator.sessionId, getSessionFile: () => coordinator.sessionFile,
    getLeafId: () => 'coordinator-leaf', getBranch: () => [{ type: 'custom',
      customType: 'pi-continuation-coordinator', data: coordinator }],
  } };
  bindCoordinator({ on: (name, fn) => ch.set(name, fn), registerCommand: () => {},
    sendMessage: message => notices.push(message) }, { root, paneId: coordinator.paneId, socketPath });
  await ch.get('session_start')({}, cctx);
  if (coordinatorInput) ch.get('input')({ source: 'interactive' });
  const ctx = { mode: 'tui', isIdle: () => false,
    sessionManager: { getSessionId: () => 'supervisor' },
    ui: { confirm: async () => true, notify: () => {} } };
  await new Promise(resolve => herdr.listen(endpoint(socketPath), resolve));
  bindSupervisor({ on: (name, fn) => sh.set(name, fn),
    registerCommand: (_name, definition) => { command = definition.handler; },
    registerTool: definition => { tool = definition.execute; }, sendMessage: message => wakes.push(message) },
  { root, socketPath, allowExperimentalActivation: true });
  t.after(async () => {
    await sh.get('session_shutdown')?.();
    await ch.get('session_shutdown')?.();
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => herdr.close(resolve));
    await rm(root, { recursive: true, force: true });
    if (prior === undefined) delete process.env.HERDR_ENV;
    else process.env.HERDR_ENV = prior;
  });
  await command('init', ctx);
  return { root, worker, coordinator, agents, observation, ch, sh, ctx, cctx, notices, wakes,
    createWorker: async (workspace = 'w', checkpoint) => {
      const next = { ...binding(randomUUID(), `${workspace}:${randomUUID()}`, workspace) };
      next.workerId = next.id;
      next.checkpoint = checkpoint ?? join(root, `${next.id}.md`);
      if (!checkpoint) await writeFile(next.checkpoint, 'State: in progress');
      await atomicJson(join(root, `worker-${next.id}.json`), next);
      return next;
    },
    state: () => readJson(join(root, 'supervisor.json')),
    command: args => command(args, ctx),
    disposition: (action, kind) => tool('call', { workerId: worker.id, stop, action, kind,
      evidence: 'Validated result' }, undefined, undefined, ctx),
    event: () => { for (const socket of subscriptions) socket.write(JSON.stringify({ event: 'pane.updated' }) + '\n'); },
  };
}

test('pre-acceptance coordinator rejection stays pending, then delivers once without a model wake', async t => {
  const s = await fixture(t, { coordinatorInput: true });
  await s.disposition('notify', 'completion');
  let state = await s.state();
  assert.equal(Object.values(state.notices)[0].status, 'pending');
  assert.equal(state.routes.w.paused, false);
  assert.equal(s.notices.length, 0);
  s.ch.get('agent_settled')();
  s.event();
  await eventually(async () => Object.values((await s.state()).notices)[0].status === 'sent');
  assert.equal(s.notices.length, 1);
  assert.equal(s.wakes.length, 0);
});

test('completion superseded during handoff is rejected by the recipient without a route pause', async t => {
  const s = await fixture(t);
  s.cctx.isIdle = () => {
    writeFileSync(join(s.root, `observation-${s.worker.id}.json`), JSON.stringify({
      ...s.observation, outcome: 'working', stop: null,
    }));
    return true;
  };
  await s.disposition('notify', 'completion');
  assert.equal(Object.values((await s.state()).notices)[0].status, 'stale');
  assert.equal((await s.state()).routes.w.paused, false);
  assert.equal(s.notices.length, 0);
});

test('a changed checkpoint path isolates the worker instead of reading another assignment', async t => {
  const s = await fixture(t, { coordinatorInput: true });
  const other = await s.createWorker();
  await s.command(`add ${other.id} w`);
  await s.command(`activate worker ${other.id}`);
  await atomicJson(join(s.root, `worker-${s.worker.id}.json`), { ...s.worker, checkpoint: other.checkpoint });
  s.event();
  await eventually(async () => (await s.state()).workers[s.worker.id].paused);
  const state = await s.state();
  assert.equal(state.workers[other.id].paused, false);
  assert.equal(state.routes.w.paused, false);
  assert.match(state.workers[s.worker.id].reason, /checkpoint/);
  assert.match((await s.disposition('resume')).content[0].text, /Paused/);
});

test('post-acceptance coordinator race remains uncertain and is never retried', async t => {
  const s = await fixture(t);
  let checks = 0;
  s.cctx.isIdle = () => ++checks === 1;
  await s.disposition('notify', 'completion');
  const state = await s.state();
  const notice = Object.values(state.notices)[0];
  assert.equal(notice.status, 'uncertain');
  assert.equal(state.routes.w.paused, true);
  assert.equal((await readJson(join(s.root, `receipt-${notice.id}.json`))).status, 'accepted');
  s.cctx.isIdle = () => true;
  s.event();
  await s.command('status');
  assert.equal(s.notices.length, 0);
  await assert.rejects(s.command('activate route w'), /Uncertain/);
});

test('coordinator loss is a sticky route pause, while worker loss is worker-local', async t => {
  const s = await fixture(t);
  const coordinatorAgent = s.agents.find(a => a.pane_id === s.coordinator.paneId);
  coordinatorAgent.agent_session.value = '/sessions/replaced.jsonl';
  s.event();
  await eventually(async () => (await s.state()).routes.w.paused);
  assert.equal((await s.state()).paused, false);
  assert.equal((await s.state()).workers[s.worker.id].paused, false);
  coordinatorAgent.agent_session.value = s.coordinator.sessionFile;
  s.event();
  await s.command('status');
  assert.equal((await s.state()).routes.w.paused, true);
  await s.command('activate route w');
  const agent = s.agents.find(a => a.pane_id === s.worker.paneId);
  agent.foreground_cwd = '/moved';
  s.event();
  await eventually(async () => (await s.state()).workers[s.worker.id].paused);
  assert.equal((await s.state()).routes.w.paused, false);
  assert.equal((await s.state()).paused, false);
  assert.match((await s.state()).workers[s.worker.id].reason, /identity/);
});

test('registration rejects checkpoint and control-role collisions and allows an exact remote coordinator', async t => {
  const s = await fixture(t);
  const duplicate = await s.createWorker('w', s.worker.checkpoint);
  await assert.rejects(s.command(`add ${duplicate.id} w`), /Duplicate/);
  await atomicJson(join(s.root, `coordinator-${s.worker.id}.json`), { ...s.worker, id: s.worker.id });
  await assert.rejects(s.command(`coordinator w ${s.worker.id}`), /worker cannot/);
  await atomicJson(join(s.root, `worker-${s.coordinator.id}.json`), {
    ...s.coordinator, workerId: s.coordinator.id, checkpoint: s.worker.checkpoint,
  });
  await assert.rejects(s.command(`add ${s.coordinator.id} c`), /coordinator cannot/);
  const remote = await s.createWorker('remote');
  await s.command(`add ${remote.id} remote`);
  await s.command(`coordinator remote ${s.coordinator.id}`);
  const state = await s.state();
  assert.equal(state.routes.remote.coordinator.workspaceId, 'c');
  assert.equal(state.routes.remote.paused, true);
  assert.equal(state.workers[remote.id].paused, true);
  await s.command(`coordinator remote ${s.coordinator.id}`);
  assert.deepEqual((await s.state()).routes.remote, state.routes.remote);
});

test('explicit worker reactivation rearms a paused disposition once without lifting route/global pauses', async t => {
  const s = await fixture(t);
  await s.disposition('pause');
  await s.command('pause global');
  await s.command('pause route w');
  await s.command(`activate worker ${s.worker.id}`);
  let state = await s.state();
  assert.equal(state.handled[s.worker.id], undefined);
  assert.equal(state.paused, true);
  assert.equal(state.routes.w.paused, true);
  assert.equal(state.workers[s.worker.id].paused, false);
  await s.command(`activate worker ${s.worker.id}`);
  assert.deepEqual(await s.state(), state);
});

test('acknowledgement records completion without lifting any pause', async t => {
  const s = await fixture(t);
  await s.command(`pause worker ${s.worker.id}`);
  await s.command('pause route w');
  await s.command('pause global');
  assert.match((await s.disposition('acknowledge')).content[0].text, /acknowledged/);
  const state = await s.state();
  assert.equal(state.handled[s.worker.id], s.observation.stop);
  assert.equal(state.workers[s.worker.id].paused, true);
  assert.equal(state.routes.w.paused, true);
  assert.equal(state.paused, true);
  assert.equal(s.wakes.length + s.notices.length, 0);
});

test('supervisor Escape pauses globally rather than scheduling a corrective turn', async t => {
  const s = await fixture(t);
  s.ctx.isIdle = () => true;
  s.event();
  await eventually(() => s.wakes.length === 1);
  s.sh.get('before_agent_start')({ messageType: 'custom', message: s.wakes[0] });
  await s.sh.get('agent_settled')({ aborted: true }, s.ctx);
  assert.equal((await s.state()).paused, true);
  assert.equal(s.wakes.length, 1);
});

test('material notice disposes attention and blocker pauses only its worker before deferred delivery', async t => {
  const s = await fixture(t, { coordinatorInput: true });
  await s.disposition('notify', 'blocker');
  const state = await s.state();
  assert.equal(state.workers[s.worker.id].paused, true);
  assert.equal(state.handled[s.worker.id], s.observation.stop);
  assert.equal(state.routes.w.paused, false);
  assert.equal(state.paused, false);
  assert.match((await s.disposition('resume')).content[0].text, /Paused/);
});
