import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomicJson, readJson } from '../src/store.mjs';
import { receive } from '../src/receiver.mjs';
import { endpoint } from '../src/herdr.mjs';
import { bindSupervisor } from '../src/supervisor.mjs';
import { bindCoordinator } from '../src/coordinator.mjs';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

test('explicit activation and evidence deliver once to exact stop, without a live worker', async () => {
  const root = await mkdtemp(join(tmpdir(), 'continuation-'));
  const herdrPath = process.platform === 'win32' ? `test-${randomUUID()}` : join(root, 'herdr.sock');
  const checkpoint = join(root, 'checkpoint.md');
  const workerId = randomUUID();
  const sessionFile = '/sessions/test.jsonl';
  const record = { workerId, paneId: 'w1:p1', sessionId: 'session-test', sessionFile,
    checkpoint, cwd: '/project', paused: true };
  const stop = randomUUID();
  const siblingId = randomUUID();
  const sibling = { ...record, workerId: siblingId, paneId: 'w2:p1',
    sessionId: 'sibling-session', sessionFile: '/sessions/sibling.jsonl' };
  const siblingStop = randomUUID();
  const observation = { outcome: 'completed', stop, version: 0,
    session: { id: record.sessionId, file: sessionFile, leaf: 'leaf' } };
  const agent = { pane_id: 'w1:p1', tab_id: 'w1:t1', workspace_id: 'w1',
    terminal_id: 'terminal', cwd: '/project', agent: 'pi', agent_status: 'idle',
    completion_seq: 1, agent_session: { source: 'herdr:pi', agent: 'pi', kind: 'path', value: sessionFile } };
  const coordinatorId = randomUUID();
  const coordinatorRecord = { id: coordinatorId, sessionId: 'coordinator-session',
    sessionFile: '/sessions/coordinator.jsonl', cwd: '/project', paneId: 'w1:p2' };
  const coordinatorAgent = { ...agent, pane_id: coordinatorRecord.paneId,
    terminal_id: 'coordinator-terminal', agent_session: { ...agent.agent_session,
      value: coordinatorRecord.sessionFile }, agent_status: 'working' };
  let subscription;
  const subscriptionRequests = [];
  const siblingAgent = { ...agent, pane_id: sibling.paneId, tab_id: 'w2:t1',
    workspace_id: 'w2', terminal_id: 'terminal-two',
    agent_session: { ...agent.agent_session, value: sibling.sessionFile } };
  const herdr = net.createServer(socket => socket.once('data', data => {
    const req = JSON.parse(data.toString());
    if (req.method === 'events.subscribe') {
      subscriptionRequests.push(req.params.subscriptions);
      subscription = socket;
      socket.write(JSON.stringify({ id: req.id, result: { type: 'subscription_started' } }) + '\n');
    } else if (req.method === 'session.snapshot') {
      socket.end(JSON.stringify({ id: req.id, result: { type: 'session_snapshot',
        snapshot: { protocol: 22, agents: [agent, siblingAgent, coordinatorAgent] } } }) + '\n');
    } else assert.fail('unexpected Herdr method');
  }));
  let stopWorker;
  const coordinatorMessages = [];
  let stopCoordinator;
  const messages = [];
  const handlers = new Map();
  const pi = { on: (event, fn) => handlers.set(event, fn),
    registerCommand: (_name, definition) => { pi.command = definition.handler; },
    registerTool: definition => { pi.tool = definition.execute; },
    sendMessage: (message, options) => messages.push({ message, options }) };
  const ctx = { mode: 'tui', isIdle: () => true,
    sessionManager: { getSessionId: () => 'supervisor-test' },
    ui: { confirm: async () => true, notify: () => {} } };
  const original = process.env.HERDR_ENV;
  process.env.HERDR_ENV = '1';
  try {
    await writeFile(checkpoint, 'in progress: completed concrete result A');
    await atomicJson(join(root, `worker-${workerId}.json`), record);
    await atomicJson(join(root, `observation-${workerId}.json`), observation);
    await atomicJson(join(root, `coordinator-${coordinatorId}.json`), coordinatorRecord);
    await atomicJson(join(root, `worker-${siblingId}.json`), sibling);
    await atomicJson(join(root, `observation-${siblingId}.json`), {
      session: { id: sibling.sessionId, file: sibling.sessionFile, leaf: 'sibling-leaf' },
      outcome: 'completed', stop: siblingStop,
    });
    await new Promise(resolve => herdr.listen(endpoint(herdrPath), resolve));
    stopWorker = await receive(root, record, { sendMessage: (...args) => messages.push(args) },
      { mode: 'tui', isIdle: () => true, sessionManager: {
        getSessionId: () => record.sessionId, getSessionFile: () => record.sessionFile,
        getLeafId: () => 'leaf',
      } }, () => 0);
    const coordinatorHandlers = new Map();
    const coordinatorPi = { on: (event, fn) => coordinatorHandlers.set(event, fn),
      registerCommand: (_name, definition) => { coordinatorPi.command = definition.handler; },
      appendEntry: () => {}, sendMessage: (...args) => coordinatorMessages.push(args) };
    const coordinatorCtx = { mode: 'tui', cwd: '/project', isIdle: () => true,
      sessionManager: { getSessionId: () => coordinatorRecord.sessionId,
        getSessionFile: () => coordinatorRecord.sessionFile, getLeafId: () => 'coordinator-leaf',
        getBranch: () => [{ type: 'custom', customType: 'pi-continuation-coordinator',
          data: { id: coordinatorId, sessionId: coordinatorRecord.sessionId, paneId: coordinatorRecord.paneId } }] } };
    bindCoordinator(coordinatorPi, { root, paneId: coordinatorRecord.paneId });
    await coordinatorHandlers.get('session_start')({}, coordinatorCtx);
    stopCoordinator = () => coordinatorHandlers.get('session_shutdown')();
    bindSupervisor(pi, { root, socketPath: herdrPath, allowExperimentalActivation: false });
    await pi.command('init', ctx);
    await pi.command(`add ${workerId} w1`, ctx);
    await assert.rejects(pi.command(`activate worker ${workerId}`, ctx), /Activation disabled/);
    assert.equal((await readJson(join(root, 'supervisor.json'))).workers[workerId].paused, true);
    await handlers.get('session_shutdown')();
    bindSupervisor(pi, { root, socketPath: herdrPath, allowExperimentalActivation: true });
    await pi.command('init', ctx);
    await pi.command(`add ${workerId} w1`, ctx);
    await pi.command(`add ${siblingId} w2`, ctx);
    await pi.command(`coordinator w1 ${coordinatorId}`, ctx);
    assert.deepEqual(subscriptionRequests.at(-1).filter(s => s.type === 'pane.agent_status_changed')
      .map(s => s.pane_id).sort(), ['w1:p1', 'w1:p2', 'w2:p1']);
    assert.equal((await readJson(join(root, 'supervisor.json'))).workers[workerId].paused, true);
    await pi.command('activate worker ' + workerId, ctx);
    await pi.command('activate route w1', ctx);
    await pi.command(`activate worker ${siblingId}`, ctx);
    await pi.command('activate route w2', ctx);
    assert.equal((await pi.tool('call', { workerId, stop, action: 'resume', evidence: 'concrete result A' },
      undefined, undefined, ctx)).content[0].text, 'Paused');
    await pi.command('activate global', ctx);
    const queuedNotice = await pi.tool('call', { workerId, stop,
      action: 'notify', kind: 'blocker', evidence: 'concrete result A' }, undefined, undefined, ctx);
    assert.match(queuedNotice.content[0].text, /pending/);
    coordinatorAgent.agent_status = 'idle';
    subscription.write(JSON.stringify({ event: 'pane.agent_status_changed', data: {} }) + '\n');
    for (let i = 0; i < 40 && coordinatorMessages.length === 0; i++) await wait(10);
    assert.equal(coordinatorMessages.length, 1);
    assert.equal(Object.values((await readJson(join(root, 'supervisor.json'))).notices)[0].status, 'sent');
    coordinatorAgent.agent_status = 'working';
    await writeFile(checkpoint, 'State: backlog empty\nconcrete result A');
    const completion = await pi.tool('call', { workerId, stop,
      action: 'notify', kind: 'completion', evidence: 'concrete result A' }, undefined, undefined, ctx);
    assert.match(completion.content[0].text, /pending/);
    await atomicJson(join(root, `observation-${workerId}.json`), { ...observation, stop: randomUUID() });
    coordinatorAgent.agent_status = 'idle';
    subscription.write(JSON.stringify({ event: 'pane.agent_status_changed', data: {} }) + '\n');
    for (let i = 0; i < 40; i++) {
      if (Object.values((await readJson(join(root, 'supervisor.json'))).notices).some(n => n.status === 'stale')) break;
      await wait(10);
    }
    assert.equal(coordinatorMessages.length, 1);
    assert.ok(Object.values((await readJson(join(root, 'supervisor.json'))).notices).some(n => n.status === 'stale'));
    await atomicJson(join(root, `observation-${workerId}.json`), observation);
    const attention = messages.find(m => !Array.isArray(m) && m.message.customType === 'pi-continuation-attention');
    assert.match(attention.message.content, new RegExp(workerId));
    assert.match(attention.message.content, new RegExp(siblingId));
    const answer = await pi.tool('call', { workerId, stop, action: 'resume', evidence: 'concrete result A' },
      undefined, undefined, ctx);
    assert.match(answer.content[0].text, /delivered/);
    assert.equal(messages.filter(m => Array.isArray(m)).length, 1);
    const repeat = await pi.tool('call', { workerId, stop, action: 'resume', evidence: 'concrete result A' },
      undefined, undefined, ctx);
    assert.match(repeat.content[0].text, /Stale/);
    const second = randomUUID();
    await atomicJson(join(root, `observation-${workerId}.json`), { ...observation, stop: second });
    const secondAnswer = await pi.tool('call', { workerId, stop: second, action: 'resume', evidence: 'concrete result A' },
      undefined, undefined, ctx);
    assert.match(secondAnswer.content[0].text, /delivered/);
    const third = randomUUID();
    await atomicJson(join(root, `observation-${workerId}.json`), { ...observation, stop: third });
    const thirdAnswer = await pi.tool('call', { workerId, stop: third, action: 'resume', evidence: 'concrete result A' },
      undefined, undefined, ctx);
    assert.match(thirdAnswer.content[0].text, /Two nudges/);
    assert.equal((await readJson(join(root, 'supervisor.json'))).workers[workerId].paused, true);
    assert.equal(messages.filter(m => Array.isArray(m)).length, 2);
    await handlers.get('session_shutdown')();
    bindSupervisor(pi, { root, socketPath: herdrPath, allowExperimentalActivation: false });
    await pi.command('init', ctx);
    assert.equal((await readJson(join(root, 'supervisor.json'))).paused, true);
    assert.equal((await pi.tool('call', { workerId: siblingId, stop: siblingStop,
      action: 'resume', evidence: 'concrete result A' }, undefined, undefined, ctx)).content[0].text,
    'Activation disabled: prompt-hold boundary unverified');
    assert.equal(messages.filter(m => Array.isArray(m)).length, 2);
  } finally {
    await handlers.get('session_shutdown')?.();
    await stopWorker?.();
    await stopCoordinator?.();
    subscription?.destroy();
    await new Promise(resolve => herdr.close(resolve));
    await rm(root, { recursive: true, force: true });
    if (original === undefined) delete process.env.HERDR_ENV;
    else process.env.HERDR_ENV = original;
  }
});
