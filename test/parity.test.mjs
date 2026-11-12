import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomicJson, readJson } from '../src/store.mjs';
import { endpoint } from '../src/herdr.mjs';
import { bindSupervisor } from '../src/supervisor.mjs';
import { bindContinuation } from '../src/ordinary.mjs';
import { bindCoordinator } from '../src/coordinator.mjs';
import { checkpointHash } from '../src/policy.mjs';
import { ownerAlive } from '../src/ipc.mjs';

async function eventually(predicate) {
  // Polling the same JSON file too aggressively can contend with atomic replacement
  // on Windows; the deadline bounds a genuinely missing state without a 1s CI race.
  const deadline = Date.now() + 5000;
  do {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  } while (Date.now() < deadline);
  assert.fail('Expected state did not arrive');
}

// Real local transport and persistence; only the Pi lifecycle and Herdr server are fake.
async function fixture(t, { coordinatorInput = false, ordinary = false, priorHandled = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'continuation-'));
  const socketPath = process.platform === 'win32' ? `test-${randomUUID()}` : join(root, 'herdr.sock');
  const prior = process.env.HERDR_ENV;
  process.env.HERDR_ENV = '1';
  const agents = [];
  function binding(id, paneId, workspaceId) {
    const sessionFile = join(root, `${id}.jsonl`);
    writeFileSync(sessionFile, '{}\n');
    const value = { id, paneId, sessionId: id, sessionFile, cwd: '/project',
      terminalId: id, workspaceId, tabId: `${workspaceId}:tab`, sessionKind: 'path', sessionValue: sessionFile };
    agents.push({ agent: 'pi', pane_id: paneId, terminal_id: id, workspace_id: workspaceId,
      tab_id: value.tabId, cwd: value.cwd, agent_status: 'idle', state_change_seq: 1, completion_seq: 1,
      agent_session: { source: 'herdr:pi', agent: 'pi', kind: 'path', value: sessionFile } });
    return value;
  }
  const coordinator = binding(randomUUID(), 'c:p1', 'c');
  const worker = { ...binding(randomUUID(), 'w:p1', 'w'), route: 'w', paused: false };
  worker.workerId = worker.id;
  worker.checkpoint = join(root, 'checkpoint.md');
  const stop = randomUUID();
  const observation = { outcome: 'completed', stop, version: 0, hold: false,
    finalReply: 'Synthetic result: continue approved work.',
    session: { id: worker.sessionId, file: worker.sessionFile, leaf: 'leaf' } };
  await writeFile(worker.checkpoint, '# Work report\nValidated result\nAll assigned tasks and follow-ups completed.');
  // Match real registration: persisted checkpoint pins are canonical even when
  // the OS temporary directory itself is a symlink (for example on macOS).
  worker.checkpoint = await realpath(worker.checkpoint);
  await atomicJson(join(root, `worker-${worker.id}.json`), worker);
  await atomicJson(join(root, `observation-${worker.id}.json`), observation);
  await atomicJson(join(root, `coordinator-${coordinator.id}.json`), coordinator);
  await atomicJson(join(root, 'supervisor.json'), { paused: false,
    workers: { [worker.id]: worker }, routes: { w: { paused: false, coordinator } },
    handled: priorHandled ? { [worker.id]: stop } : {}, resumed: {} });
  const sockets = new Set();
  const subscriptions = new Set();
  let snapshotHook = () => {};
  const herdr = net.createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => { sockets.delete(socket); subscriptions.delete(socket); });
    socket.once('data', data => {
      const req = JSON.parse(data.toString());
      if (req.method === 'events.subscribe') subscriptions.add(socket);
      else snapshotHook();
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
  const supervisorPi = { on: (name, fn) => {
    const previous = sh.get(name);
    sh.set(name, previous ? (...args) => Promise.all([previous(...args), fn(...args)]) : fn);
  },
    registerCommand: (name, definition) => {
      if (name === 'continuation-supervisor') command = definition.handler;
    },
    registerTool: definition => { tool = definition.execute; }, sendMessage: message => wakes.push(message) };
  if (ordinary) bindContinuation(supervisorPi, { root, socketPath });
  else bindSupervisor(supervisorPi, { root, socketPath, allowExperimentalActivation: true });
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
    dispose: (args, signal) => tool('call', args, signal, undefined, ctx),
    onSnapshot: fn => { snapshotHook = fn; },
    command: args => command(args, ctx),
    disposition: async (action, kind, reportHash, evidence = 'Validated result') => tool('call',
      { workerId: worker.id, stop, action, kind, evidence,
        reportHash: reportHash ?? checkpointHash(await readFile(worker.checkpoint, 'utf8')) },
    undefined, undefined, ctx),
    event: () => { for (const socket of subscriptions) socket.write(JSON.stringify({ event: 'pane.updated' }) + '\n'); },
  };
}

test('P1 ordinary loading permits human scoped activation without an SDK opt-in', async t => {
  const s = await fixture(t, { ordinary: true });
  await s.command('pause global');
  assert.equal((await s.state()).paused, true);
  await s.command('activate global');
  assert.equal((await s.state()).paused, false);
  assert.equal((await s.state()).workers[s.worker.id].paused, false);
});

test('P3 blocked mid-turn attention is distinct, deduplicated and material-only', async t => {
  const s = await fixture(t, { priorHandled: true });
  const native = { ...s.observation, outcome: 'working', stop: null };
  await atomicJson(join(s.root, `observation-${s.worker.id}.json`), native);
  const agent = s.agents.find(a => a.pane_id === s.worker.paneId);
  agent.agent_status = 'blocked';
  agent.state_change_seq = 2;
  s.ctx.isIdle = () => true;
  s.event();
  await eventually(() => s.wakes.length === 1);
  const content = s.wakes[0].content;
  const [evidence] = JSON.parse(content.slice(content.indexOf('[{')));
  assert.equal(evidence.outcome, 'blocked');
  assert.equal(evidence.finalReply, undefined);
  assert.match(evidence.statusEvidence, /Herdr reports blocked/);
  const token = (await s.state()).blocked[s.worker.id].stop;
  assert.equal(evidence.stop, token);
  assert.notEqual(token, s.observation.stop);
  s.event();
  assert.match((await s.dispose({ workerId: s.worker.id, stop: token,
    action: 'resume', evidence: 'Validated result' })).content[0].text, /ineligible/);
  assert.equal((await s.state()).blocked[s.worker.id].stop, token);
  assert.match((await s.dispose({ workerId: s.worker.id, stop: token,
    action: 'notify', kind: 'completion', evidence: 'Validated result' })).content[0].text, /ineligible/);
  const notice = await s.dispose({ workerId: s.worker.id, stop: token,
    action: 'notify', kind: 'decision', evidence: 'Herdr reports blocked' });
  assert.match(notice.content[0].text, /Material notice sent/);
  assert.equal((await s.state()).workers[s.worker.id].paused, true);
  assert.equal(s.notices.length, 1);
  assert.equal(s.wakes.length, 1);
  assert.equal((await s.state()).handled[s.worker.id], s.observation.stop);
  assert.equal((await s.state()).resumed[s.worker.id], undefined);
  assert.equal((await s.state()).blocked[s.worker.id].handled, true);
  await assert.rejects(s.command(`activate worker ${s.worker.id}`), /Worker blocked/);
  assert.equal((await s.state()).workers[s.worker.id].paused, true);
  assert.deepEqual(await readJson(join(s.root, `observation-${s.worker.id}.json`)), native);
});

for (const change of ['blocked', 'replacement', 'new sequence', 'missing sequence', 'cancelled']) {
  test(`P2/P3 near-delivery Herdr recheck refuses ${change} without spending a nudge`, async t => {
    const s = await fixture(t);
    let reads = 0;
    const controller = new AbortController();
    s.onSnapshot(() => {
      if (++reads !== 2) return;
      const agent = s.agents.find(a => a.pane_id === s.worker.paneId);
      if (change === 'blocked') agent.agent_status = 'blocked';
      if (change === 'replacement') agent.terminal_id = 'replaced';
      if (change === 'new sequence') agent.state_change_seq++;
      if (change === 'missing sequence') delete agent.state_change_seq;
      if (change === 'cancelled') controller.abort();
    });
    const answer = await s.dispose({ workerId: s.worker.id, stop: s.observation.stop,
      action: 'resume', evidence: 'Validated result' }, controller.signal);
    assert.match(answer.content[0].text, /paused before delivery; no continuation sent/);
    const state = await s.state();
    assert.equal(state.workers[s.worker.id].paused, true);
    assert.equal(state.inflight[s.worker.id], undefined);
    assert.equal(state.budgets[s.worker.id], undefined);
    assert.equal(state.resumed[s.worker.id], undefined);
  });
}

test('a final-reply approval question can suspend the worker and route an exact decision', async t => {
  const s = await fixture(t);
  const question = 'Can I deploy to production?';
  await atomicJson(join(s.root, `observation-${s.worker.id}.json`),
    { ...s.observation, finalReply: question });
  assert.match((await s.disposition('resume', undefined, undefined, question)).content[0].text,
    /Evidence is absent/);
  const result = await s.disposition('notify', 'decision', undefined, question);
  assert.match(result.content[0].text, /Material notice/);
  const state = await s.state();
  assert.equal(state.workers[s.worker.id].paused, true);
  assert.equal(Object.values(state.notices)[0].text, question);
  assert.equal(Object.values(state.notices)[0].kind, 'decision');
  assert.equal(state.resumed[s.worker.id], undefined);
  assert.equal(state.inflight[s.worker.id], undefined);
});

test('pre-acceptance coordinator rejection stays pending, then delivers once without a model wake', async t => {
  const s = await fixture(t, { coordinatorInput: true });
  await s.disposition('notify', 'completion');
  let state = await s.state();
  assert.equal(Object.values(state.notices)[0].kind, 'completion');
  assert.equal(Object.values(state.notices)[0].status, 'pending');
  assert.equal(state.routes.w.paused, false);
  assert.equal(s.notices.length, 0);
  s.ch.get('agent_settled')();
  s.event();
  await eventually(async () => Object.values((await s.state()).notices)[0].status === 'sent');
  assert.equal(s.notices.length, 1);
  assert.equal(s.wakes.length, 0);
});

test('a queued completion notice is discarded if the report changes without a new stop', async t => {
  const s = await fixture(t, { coordinatorInput: true });
  await s.disposition('notify', 'completion');
  await writeFile(s.worker.checkpoint, '# Work report\nValidated result\nFollow-up reopened.');
  s.ch.get('agent_settled')();
  s.event();
  await eventually(async () => Object.values((await s.state()).notices)[0].status === 'stale');
  assert.equal(s.notices.length, 0);
  assert.equal((await s.state()).routes.w.paused, false);
  assert.equal((await s.state()).handled[s.worker.id], undefined);
  await writeFile(s.worker.checkpoint, '# Work report\nValidated result\nFollow-up closed.');
  await s.disposition('notify', 'completion');
  const notices = Object.values((await s.state()).notices);
  assert.deepEqual(notices.map(n => n.status), ['stale', 'sent']);
  assert.equal(s.notices.length, 1);
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
  assert.equal(Object.values((await s.state()).notices)[0].kind, 'completion');
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
  assert.equal(state.workers[other.id].paused, false,
    JSON.stringify({ reason: state.workers[other.id].reason, failure: state.workers[other.id].failure }));
  assert.equal(state.routes.w.paused, false);
  assert.match(state.workers[s.worker.id].reason, /checkpoint/);
  const disposition = (await s.disposition('resume')).content[0].text;
  const afterMismatch = await s.state();
  assert.match(disposition, /Paused/,
    JSON.stringify({ reason: afterMismatch.reason, failure: afterMismatch.failure }));
});

test('a report edit during handoff is rejected before claiming a receipt', async t => {
  const s = await fixture(t);
  let checks = 0;
  s.cctx.isIdle = () => {
    if (++checks === 1) writeFileSync(s.worker.checkpoint, '# Work report\nValidated result\nFollow-up reopened.');
    return true;
  };
  await s.disposition('notify', 'completion');
  const notice = Object.values((await s.state()).notices)[0];
  assert.equal(notice.status, 'stale');
  assert.equal((await s.state()).routes.w.paused, false);
  await assert.rejects(readJson(join(s.root, `receipt-${notice.id}.json`)), { code: 'ENOENT' });
  assert.equal(s.notices.length, 0);
});

test('report changes after receipt claim suspend the completion notice without retry', async t => {
  const s = await fixture(t);
  s.onSnapshot(() => {
    const notices = Object.values(JSON.parse(readFileSync(join(s.root, 'supervisor.json'))).notices);
    const notice = notices.find(n => n.kind === 'completion' && n.status === 'sending');
    if (notice && existsSync(join(s.root, `receipt-${notice.id}.json`)))
      writeFileSync(s.worker.checkpoint, '# Work report\nValidated result\nFollow-up reopened.');
  });
  await s.disposition('notify', 'completion');
  const notice = Object.values((await s.state()).notices)[0];
  assert.equal(notice.status, 'uncertain');
  assert.equal((await s.state()).routes.w.paused, true);
  assert.equal((await readJson(join(s.root, `receipt-${notice.id}.json`))).status, 'accepted');
  assert.equal(s.notices.length, 0);
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
  const afterCoordinatorLoss = await s.state();
  assert.equal(afterCoordinatorLoss.paused, false,
    JSON.stringify({ reason: afterCoordinatorLoss.reason, failure: afterCoordinatorLoss.failure }));
  assert.equal(afterCoordinatorLoss.workers[s.worker.id].paused, false);
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

test('unpersistable pause withdraws the owner endpoint and retains the recovery lock', async t => {
  const s = await fixture(t);
  const owner = await readJson(join(s.root, 'supervisor.lock'));
  // A real temporary-filesystem failure, not a fake successful pause write.
  await rm(join(s.root, 'supervisor.json'));
  await mkdir(join(s.root, 'supervisor.json'));
  assert.match((await s.disposition('acknowledge')).content[0].text, /Internal error/);
  assert.equal(await ownerAlive(s.root, owner.token), false);
  assert.deepEqual(await readJson(join(s.root, 'supervisor.lock')), owner);
  assert.equal(s.wakes.length + s.notices.length, 0);
});

test('a failed human pause also withdraws the owner instead of leaving the old active snapshot authoritative', async t => {
  const s = await fixture(t);
  const owner = await readJson(join(s.root, 'supervisor.lock'));
  await rm(join(s.root, 'supervisor.json'));
  await mkdir(join(s.root, 'supervisor.json'));
  await assert.rejects(s.command('pause global'));
  assert.equal(await ownerAlive(s.root, owner.token), false);
  assert.deepEqual(await readJson(join(s.root, 'supervisor.lock')), owner);
  assert.equal(s.wakes.length + s.notices.length, 0);
});

test('an observation without an explicit cleared hold cannot be acknowledged or resumed', async t => {
  const s = await fixture(t);
  const { hold, ...legacy } = s.observation;
  await atomicJson(join(s.root, `observation-${s.worker.id}.json`), legacy);
  assert.equal((await s.disposition('acknowledge')).content[0].text, 'Stale or ineligible stop');
  assert.equal((await s.disposition('resume')).content[0].text, 'Stale or ineligible stop');
  assert.equal((await s.disposition('notify', 'completion')).content[0].text, 'Stale or ineligible stop');
  await atomicJson(join(s.root, `observation-${s.worker.id}.json`),
    { ...s.observation, outcome: 'approval', hold: true });
  assert.equal((await s.disposition('notify', 'completion')).content[0].text, 'Stale or ineligible stop');
  assert.equal((await s.state()).handled[s.worker.id], undefined);
  assert.deepEqual((await s.state()).notices, {});
});

test('acknowledgement rejects a changed report without consuming the stop', async t => {
  const s = await fixture(t);
  const oldHash = checkpointHash(await readFile(s.worker.checkpoint, 'utf8'));
  await writeFile(s.worker.checkpoint, '# Work report\nValidated result\nAll assigned tasks complete; formatting revised.');
  assert.match((await s.disposition('acknowledge', undefined, oldHash)).content[0].text, /changed/);
  assert.equal((await s.state()).handled[s.worker.id], undefined);
  assert.match((await s.disposition('acknowledge')).content[0].text, /acknowledged/);
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
