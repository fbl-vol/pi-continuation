import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { startFixture } from './fixtures/start-flow.mjs';
import { atomicJson, readJson } from '../src/store.mjs';
import { sendAction } from '../src/ipc.mjs';
import { attentionContent } from '../src/attention.mjs';
import { delegationInstructions, spawnDelegated } from '../src/delegation.mjs';
import { checkpointHash } from '../src/policy.mjs';

async function fixture(t, options = {}) {
  const f = await startFixture(t, { blank: true });
  execFileSync('git', ['init', '--quiet', f.root]);
  await f.supervisorCommand('start');
  const effects = [], children = [];
  let serial = 0;
  f.onRequest(async request => {
    const { method, params } = request;
    if (method === 'pane.get' && options.closedPanes?.includes(params.pane_id))
      throw Object.assign(new Error('Pane closed'), { code: 'pane_not_found' });
    if (method === 'pane.split') {
      effects.push('split');
      await options.beforeSplit?.(f);
      const id = `w:p${++serial + 10}`;
      const pane = { pane_id: id, terminal_id: `terminal-${id}`, workspace_id: 'w', tab_id: 'w:t1' };
      children.push({ pane, env: params.env });
      assert.equal(params.focus, false);
      assert.equal(params.cwd, f.root);
      if (options.splitLost) throw new Error('lost split response after creation');
      return { type: 'pane_info', pane }; // Herdr 0.9.5 replies with PaneInfo, not its PaneCreated event.
    }
    if (method === 'agent.start') {
      effects.push('start');
      const child = children.find(c => c.pane.pane_id === params.pane_id);
      // Native Herdr 0.9.5 validates this before sending any shell input.
      assert.match(params.name, /^[a-z][a-z0-9_-]{0,31}$/);
      child.name = params.name;
      assert.equal(children.filter(c => c.name === child.name).length, 1);
      assert.deepEqual(params.args, []); // ordinary startup; no SDK/extension-order launcher
      const native = f.native(params.pane_id, { delegationId: child.env.PI_CONTINUATION_SPAWN,
        allowTask: true, suppressRun: options.suppressRun,
        onTask: task => {
          const state = JSON.parse(readFileSync(join(f.root, 'supervisor.json'), 'utf8'));
          const enrolled = Object.values(state.workers).find(w => w.paneId === params.pane_id);
          assert.equal(enrolled?.lastStartNonce, child.env.PI_CONTINUATION_SPAWN,
            'owner must durably enroll the exact worker BEFORE native task dispatch');
          assert.equal(enrolled.sessionId, child.native.id);
          assert.equal(enrolled.paused, false);
          effects.push('task'); child.task = task;
          options.onTask?.(f, child);
        } });
      child.native = native;
      child.agent = { ...child.pane, name: params.name, agent: 'pi', cwd: f.root, agent_status: 'idle',
        interactive_ready: true, completion_seq: 1, state_change_seq: 1,
        agent_session: { source: 'herdr:pi', agent: 'pi', kind: 'path', value: native.file } };
      f.agents.push(child.agent);
      await native.emit('session_start', { reason: 'startup' });
      await options.afterStart?.(f, child);
      if (options.startLost) throw new Error('lost start response');
      const agent = options.pendingStart ? { ...child.agent, agent_status: 'unknown',
        launch_pending: true, interactive_ready: false, agent_session: undefined } : child.agent;
      return { type: 'agent_started', agent, argv: ['pi'] };
    }
    if (method === 'agent.get') {
      effects.push('readiness');
      const child = children.find(c => c.pane.pane_id === params.target);
      return { type: 'agent_info', agent: { ...child.agent, ...options.readinessPatch } };
    }
    await options.onSnapshot?.(f, children, request);
  });
  const authorize = (scope = 'Implement the approved fixture feature. Read-only subdelegation is permitted; user selects review fixes.') =>
    f.worker.command('continuation-delegate', `writer ${scope}`);
  const attempts = async () => (await readdir(f.root)).filter(p => /^spawn-[a-f0-9-]{36}\.json$/.test(p));
  return { ...f, effects, children, authorize, attempts,
    attempt: async () => readJson(join(f.root, (await attempts())[0])) };
}
const task = { key: 'implementation', task: 'Implement approved stage one and validate it.', role: 'writer' };

test('P1/P2/P7 unsupervised planner creates only a new identity, enrolls before task, and inherits bounded subdelegation', async t => {
  const f = await fixture(t);
  await f.authorize();
  assert.equal(f.workerId(), undefined, 'the planner never enrolled');
  const result = (await f.worker.spawn(task)).details;
  assert.equal(result.status, 'dispatched');
  assert.deepEqual(f.effects, ['split', 'start', 'task']);
  const child = f.children[0];
  const state = await f.state();
  assert.equal(state.workers[result.workerId].sessionId, child.native.id);
  assert.equal(state.workers[result.workerId].sessionFile, child.native.file);
  assert.equal(state.workers[result.workerId].lastStartNonce, result.id);
  assert.equal(state.workers[result.workerId].paused, false, JSON.stringify(state.workers[result.workerId]));
  assert.equal(child.native.confirmations.length, 0, 'no simulated/per-worker human confirmation');
  assert.match(child.task, /Approved delegation scope/);
  assert.match(child.task, /Awaiting user finding selection is a genuine decision pause/);
  assert.equal((await readJson(join(f.root, `spawn-receipt-${result.id}.json`))).status, 'sent');
  assert.match(await readFile(child.native.file, 'utf8'), /Implement approved stage one/);
  // The cooperating implementation writer may create read-only subworkers, not
  // a second writer against the same checkout.
  await assert.rejects(child.native.spawn({ ...task, key: 'second-writer', task: 'Another implementation writer' }), /Checkout already has a supervised worker/);
  const sub = (await child.native.spawn({ key: 'analysis', task: 'Inspect implementation evidence without edits.', role: 'read-only' })).details;
  assert.equal(sub.status, 'dispatched');
  assert.equal(f.children[1].native.confirmations.length, 0);
  assert.equal(Object.keys((await f.state()).workers).length, 2);
  await f.supervisorCommand('pause route w');
  const beforePausedRoute = [...f.effects];
  await assert.rejects(f.worker.spawn({ key: 'paused-route', task: 'Inspect more', role: 'read-only' }), /route is paused/);
  assert.deepEqual(f.effects, beforePausedRoute);
  await f.supervisorCommand('activate route w');
  await assert.rejects(f.children[1].native.spawn({ key: 'escape', task: 'Create a writer', role: 'writer' }), /Read-only delegates cannot create writers/);
  await assert.rejects(f.worker.spawn(task), /EEXIST/);
  await assert.rejects(f.worker.spawn({ ...task, key: 'renamed' }), /EEXIST/);
  await assert.rejects(f.worker.spawn({ ...task, key: 'changed-role', role: 'read-only' }), /EEXIST/);
  assert.equal(f.effects.filter(e => e === 'task').length, 2, 'one initial task per new worker');
});

for (const readiness of ['ready', 'replaced', 'blocked']) {
  test(`P1/P7 native start acknowledgement is not readiness: ${readiness}`, async t => {
    const f = await fixture(t, { pendingStart: true, readinessPatch: readiness === 'replaced' ?
      { terminal_id: 'different-terminal' } : readiness === 'blocked' ? { agent_status: 'blocked' } : undefined });
    if (readiness === 'ready') {
      await f.worker.command('start-implementation', 'Implement the agreed fixture change.');
      assert.deepEqual(f.effects, ['split', 'start', 'readiness', 'task']);
    } else {
      await assert.rejects(f.worker.command('start-implementation', 'Implement the agreed fixture change.'),
        /held for inspection/);
      assert.deepEqual(f.effects, ['split', 'start', 'readiness']);
      assert.equal((await f.attempt()).status, 'held');
      assert.deepEqual((await f.state()).workers, {});
    }
  });
}

test('P1/P6 supervised non-writing owner delegates the sole writer and pins exact child recipient', async t => {
  const f = await fixture(t);
  await f.worker.command('continuation-coordinator', 'owner');
  await f.workerStart();
  const ownerId = f.workerId();
  const owner = (await f.state()).workers[ownerId];
  assert.equal(owner.role, 'owner');
  await f.authorize();
  const result = (await f.worker.spawn(task)).details;
  const child = (await f.state()).workers[result.workerId];
  assert.equal(child.recipient.id, owner.coordinatorId);
  assert.equal(child.recipient.sessionId, owner.sessionId);
  assert.equal(child.recipient.role, 'owner');
  assert.equal(f.effects.filter(effect => effect === 'task').length, 1);
  await f.workerStart();
  assert.equal((await f.state()).workers[ownerId].role, 'owner',
    'confirmed own-session return must not collide with child recipient');
  await assert.rejects(f.worker.spawn({ ...task, key: 'second', task: 'A second writer' }),
    /Checkout already has a supervised worker|EEXIST/);
  assert.equal(f.effects.filter(effect => effect === 'task').length, 1);
});

test('P1/P6 native launch needs no child confirmations and delegates only through the new owner', async t => {
  const f = await fixture(t);
  const scope = 'Implement the agreed fixture change and independently review it.';
  await assert.rejects(f.worker.spawn(task), /No scoped delegation grant/);
  await f.worker.command('start-implementation', scope);
  const owner = f.children[0];
  assert.equal(f.workerId(), undefined);
  assert.equal(f.worker.confirmations.length, 0);
  assert.equal(owner.native.confirmations.length, 0);
  assert.match(owner.task, /supervised coordinating owner \(not the writer\)/);
  const ownerBinding = Object.values((await f.state()).workers)[0];
  assert.equal(ownerBinding.role, 'owner');
  assert.equal(ownerBinding.sessionId, owner.native.id);
  assert.equal((await readdir(f.root)).some(file => file.startsWith('owner-launch-pending-')), false,
    'observed owner dispatch releases the checkout fence');
  await assert.rejects(f.worker.command('start-implementation', scope), /EEXIST/);
  await assert.rejects(f.worker.spawn(task), /No scoped delegation grant/);
  const writer = (await owner.native.spawn(task)).details;
  const review = { role: 'read-only', key: 'review', task: 'Independently review the writer result.' };
  await assert.rejects(f.children[1].native.spawn(review), /exact child with delegation authority/);
  const reviewer = (await owner.native.spawn(review)).details;
  const state = await f.state();
  for (const child of [writer, reviewer]) assert.equal(state.workers[child.workerId].recipient.id, ownerBinding.coordinatorId);
  await assert.rejects(owner.native.spawn({ ...task, key: 'another', task: 'Create a second writer' }), /Checkout already has/);
  assert.equal(f.effects.filter(e => e === 'task').length, 3);
});

test('P1 bare launch reads the agreed plan from chat, without a skill invocation or confirmation', async t => {
  const f = await fixture(t);
  const plan = 'Update the help text; run the focused help tests. Do not change behavior.';
  f.worker.user('Can we improve the help text?');
  f.worker.assistant(plan);
  f.worker.user('Yes, that is the plan.');
  f.worker.ctx.model = {};
  f.worker.ctx.modelRegistry = { complete: async (_model, context) => {
    assert.equal(context.tools, undefined);
    assert.deepEqual(JSON.parse(context.messages[0].content).map(x => x.text),
      ['Can we improve the help text?', plan, 'Yes, that is the plan.']);
    return { stopReason: 'stop', content: [{ type: 'text', text: JSON.stringify({
      agreement: { turn: 2, quote: 'Yes, that is the plan.' }, plan: [{ turn: 1, quote: plan }],
    }) }] };
  } };
  await f.worker.command('start-implementation', '');
  assert.ok(f.children[0].task.includes(plan));
  assert.deepEqual(f.effects, ['split', 'start', 'task']);
  assert.equal(f.worker.confirmations.length + f.children[0].native.confirmations.length, 0);
});

for (const reason of ['ambiguous', 'invented', 'changed']) {
  test(`P1 bare launch makes no pane or grant for ${reason} chat evidence`, async t => {
    const f = await fixture(t);
    f.worker.user('Please implement the new help text.');
    f.worker.ctx.model = {};
    f.worker.ctx.modelRegistry = { complete: async () => {
      if (reason === 'changed') f.worker.user('Actually, hold off for now.');
      return { stopReason: 'stop', content: [{ type: 'text', text: JSON.stringify(reason === 'ambiguous' ? null : {
        agreement: { turn: 0, quote: 'Please implement the new help text.' },
        plan: [{ turn: 0, quote: reason === 'invented' ? 'Publish a release.' : 'Please implement the new help text.' }],
      }) }] };
    } };
    await assert.rejects(f.worker.command('start-implementation', ''),
      reason === 'changed' ? /Planning session changed/ : /No single agreed assignment/);
    assert.deepEqual(f.effects, []);
    assert.equal((await readdir(f.root)).some(name => name.startsWith('delegation-')), false);
  });
}

for (const proposal of ['superseded', 'later', 'approved correction']) {
  test(`P1 bare launch binds chat scope to the latest user agreement: ${proposal}`, async t => {
    const f = await fixture(t);
    f.worker.assistant('Plan A: update help text only.');
    f.worker.user('Yes, approve Plan A.');
    f.worker.assistant('Plan B: also update the quick-start example.');
    if (proposal !== 'later') f.worker.user('Approve Plan B, but leave the installation section unchanged.');
    f.worker.ctx.model = {};
    f.worker.ctx.modelRegistry = { complete: async () => ({ stopReason: 'stop', content: [{ type: 'text',
      text: JSON.stringify({ agreement: proposal === 'later' ? { turn: 1, quote: 'Yes, approve Plan A.' } :
        { turn: 3, quote: 'Approve Plan B' }, plan: [proposal === 'superseded' ?
        { turn: 0, quote: 'Plan A: update help text only.' } : { turn: 2, quote: 'Plan B: also update the quick-start example.' }],
      }),
    }] }) };
    if (proposal === 'approved correction') {
      await f.worker.command('start-implementation', '');
      assert.match(f.children[0].task, /Plan B: also update/);
      assert.match(f.children[0].task, /leave the installation section unchanged/);
      assert.doesNotMatch(f.children[0].task, /Plan A/);
    } else {
      await assert.rejects(f.worker.command('start-implementation', ''), /No single agreed assignment/);
      assert.deepEqual(f.effects, []);
      assert.equal((await readdir(f.root)).some(name => name.startsWith('delegation-')), false);
    }
  });
}

test('P1 bare launch preserves earlier user constraints without reintroducing older proposals', async t => {
  const f = await fixture(t);
  f.worker.user('Docs only. Do not publish. Run focused tests.');
  f.worker.assistant('Rejected proposal: rewrite the implementation.');
  f.worker.user('No, keep this to documentation.');
  f.worker.assistant('Update the README.');
  f.worker.user('Yes, proceed with that plan.');
  f.worker.ctx.model = {};
  const selection = {
    agreement: { turn: 4, quote: 'Yes, proceed with that plan.' },
    plan: [{ turn: 3, quote: 'Update the README.' }],
    earlierConstraints: [{ turn: 0, quote: 'Docs only.' }],
  };
  f.worker.ctx.modelRegistry = { complete: async () => ({ stopReason: 'stop', content: [{ type: 'text',
    text: JSON.stringify(selection),
  }] }) };
  selection.earlierConstraints.push({ turn: 1, quote: 'Rejected proposal: rewrite the implementation.' });
  await assert.rejects(f.worker.command('start-implementation', ''), /No single agreed assignment/);
  assert.deepEqual(f.effects, []);
  selection.earlierConstraints.pop();
  await f.worker.command('start-implementation', '');
  assert.match(f.children[0].task, /Docs only\. Do not publish\. Run focused tests\./);
  assert.match(f.children[0].task, /Update the README\./);
  assert.doesNotMatch(f.children[0].task, /rewrite the implementation/);
  assert.deepEqual(f.effects, ['split', 'start', 'task']);
});

for (const condition of ['closed', 'pane exists', 'session moved', 'unresolved']) {
  test(`P7 writer ownership checks retain history and distinguish ${condition}`, async t => {
    const f = await fixture(t, { closedPanes: condition === 'pane exists' ? [] : ['w:old'] });
    const state = await f.state();
    const id = '11111111-1111-4111-8111-111111111111';
    const old = { workerId: id, route: 'w', paused: true, paneId: 'w:old', cwd: f.root,
      sessionId: 'old-session', sessionFile: join(f.root, 'old.jsonl'), checkpoint: join(f.root, 'old.md') };
    state.workers[id] = old;
    await writeFile(old.checkpoint, 'Historical checkpoint');
    await atomicJson(join(f.root, `worker-${id}.json`), old);
    if (condition === 'unresolved') state.inflight[id] = { id, stop: id };
    await atomicJson(join(f.root, 'supervisor.json'), state);
    // Restart fixture supervisor so its own memory has the same retained binding.
    await f.supervisor.emit('session_shutdown');
    await f.supervisorCommand('start');
    if (condition === 'session moved') f.agents.push({ ...f.agents[0], pane_id: 'w:moved',
      agent_session: { ...f.agents[0].agent_session, value: old.sessionFile } });
    if (condition === 'closed') {
      await f.worker.command('start-implementation', 'Update the docs');
      const writer = (await f.children[0].native.spawn(task)).details;
      assert.equal(writer.status, 'dispatched');
      assert.deepEqual((await f.state()).workers[id], old);
    } else {
      await assert.rejects(f.worker.command('start-implementation', 'Update the docs'), /Checkout already has a supervised worker/);
      assert.deepEqual(f.effects, []);
    }
  });
}

test('P4/P5 native launch preserves pauses and never retries uncertain pane creation', async t => {
  const f = await fixture(t, { splitLost: true });
  await f.supervisorCommand('pause global');
  await assert.rejects(f.worker.command('start-implementation', 'Agreed scope'), /Global continuation is paused/);
  assert.deepEqual(f.effects, []);
  await f.supervisorCommand('activate global');
  await assert.rejects(f.worker.command('start-implementation', 'Agreed scope'), /held for inspection.*disconnected before response/);
  await assert.rejects(f.worker.command('start-implementation', 'Agreed scope'), /EEXIST/);
  const attempt = await f.attempt();
  await assert.rejects(f.worker.command('start-implementation', 'Agreed scope.'), error =>
    error.message.includes('Unresolved owner launch') && error.message.includes(attempt.id));
  assert.equal((await readJson(join(f.root, `spawn-${attempt.id}.json`))).status, 'held');
  assert.deepEqual(f.effects, ['split']);
});

test('P1 an existing ordinary worker cannot silently upgrade into a coordinating owner', async t => {
  const f = await fixture(t);
  await f.workerStart();
  await assert.rejects(f.worker.command('continuation-coordinator', 'owner'),
    /register owner before worker enrollment/);
  assert.equal((await f.state()).workers[f.workerId()].role, undefined);
});

test('P3 owner child wait persists; user selection gate blocks child notices and delegation', async t => {
  const f = await fixture(t);
  await f.worker.command('continuation-coordinator', 'owner');
  await f.workerStart();
  await f.authorize();
  const child = (await f.worker.spawn(task)).details;
  await f.worker.wait({ kind: 'child', children: [child.workerId] });
  assert.deepEqual((await f.state()).ownerWaits[f.workerId()], { kind: 'child', children: [child.workerId] });
  await f.worker.wait({ kind: 'user' });
  assert.deepEqual((await f.state()).ownerWaits[f.workerId()], { kind: 'user' });
  f.worker.assistant('Waiting for the actual user selection.');
  await f.worker.emit('agent_settled');
  const waitingStop = (await readJson(join(f.root, `observation-${f.workerId()}.json`))).stop;
  await assert.rejects(f.worker.wait({ kind: 'child', children: [child.workerId] }), /rejected/i);
  await assert.rejects(f.worker.spawn({ key: 'review', task: 'Review after user selection.', role: 'read-only' }),
    /waiting for a user decision/);
  await f.worker.command('continuation-owner', 'resume');
  const afterRelease = await f.state();
  assert.equal(afterRelease.ownerWaits[f.workerId()]?.kind, 'released');
  assert.equal(afterRelease.handled[f.workerId()], waitingStop,
    'releasing a user wait cannot turn an old settled stop into a fresh nudge');
});

test('P3 an already-dispatched child cannot delegate across its owner user wait; stale direct owner resume is fenced', async t => {
  const f = await fixture(t);
  await f.worker.command('continuation-coordinator', 'owner');
  await f.workerStart();
  await f.authorize();
  const writer = (await f.worker.spawn(task)).details;
  const child = f.children[0].native;
  f.worker.assistant('Waiting for user selection before further review.');
  await f.worker.emit('agent_settled');
  const observed = await f.observation();
  await f.worker.wait({ kind: 'user' });

  const before = [...f.effects];
  await assert.rejects(child.spawn({ key: 'late-review', task: 'Review after selection.', role: 'read-only' }),
    /waiting for a user decision/);
  assert.deepEqual(f.effects, before, 'the inherited child cannot create even a read-only grandchild');
  assert.equal((await f.attempts()).length, 1, 'no new delegated attempt was claimed');
  const direct = await f.supervisor.dispose({ workerId: f.workerId(), stop: observed.stop,
    action: 'resume', evidence: 'Waiting for user selection before further review.' });
  assert.match(direct.content[0].text, /waiting for a user decision/i);
  assert.equal((await f.state()).inflight[f.workerId()], undefined);
  assert.equal((await f.state()).resumed[f.workerId()], undefined);
  assert.equal((await f.state()).ownerWaits[f.workerId()].kind, 'user');

  await f.worker.command('continuation-owner', 'resume');
  const released = await f.state();
  assert.equal(released.ownerWaits[f.workerId()].kind, 'released');
  assert.equal(released.workers[writer.workerId].recipient.id, released.workers[f.workerId()].coordinatorId);
  const stillGated = await f.supervisor.dispose({ workerId: f.workerId(), stop: observed.stop,
    action: 'resume', evidence: 'Waiting for user selection before further review.' });
  assert.match(stillGated.content[0].text, /waiting for a user decision/i);
  await assert.rejects(child.spawn({ key: 'release-before-turn', task: 'Review too early.', role: 'read-only' }),
    /waiting for a user decision/);
  await f.worker.emit('session_shutdown');
  await f.worker.emit('session_start');
  assert.equal((await f.state()).ownerWaits[f.workerId()].kind, 'released',
    'a restart cannot drop the release fence or synthesize a decision turn');
});

test('P6 same-workspace sibling owners receive only their assigned notices; user wait defers without sibling pause', async t => {
  const f = await fixture(t);
  await f.worker.command('continuation-coordinator', 'owner');
  await f.workerStart();
  await f.authorize();
  const first = (await f.worker.spawn(task)).details;
  const other = f.native('w:p2');
  f.agents.push({ ...f.agents[0], pane_id: 'w:p2', terminal_id: 'other-terminal',
    agent_session: { ...f.agents[0].agent_session, value: other.file } });
  await other.emit('session_start');
  await other.command('continuation-coordinator', 'owner');
  await other.command('continuation-worker', 'start');
  await other.command('continuation-delegate', 'read-only Review only the approved result.');
  const second = (await other.spawn({ key: 'review', task: 'Review stage one without edits.', role: 'read-only' })).details;
  const state = await f.state();
  assert.notEqual(state.workers[first.workerId].recipient.id, state.workers[second.workerId].recipient.id);
  assert.equal(state.workers[first.workerId].route, state.workers[second.workerId].route);
  await f.worker.wait({ kind: 'user' });
  await other.wait({ kind: 'child', children: [second.workerId] });
  other.assistant('Waiting for the reviewer before coordinating fixes.');
  await other.emit('agent_settled');
  const ownerStop = (await readJson(join(f.root, `observation-${Object.values(state.workers).find(w =>
    w.coordinatorId === state.workers[second.workerId].recipient.id).workerId}.json`))).stop;

  const reviewer = f.children[1].native;
  reviewer.assistant('Review complete with evidence.');
  await reviewer.emit('agent_settled');
  const observed = await readJson(join(f.root, `observation-${second.workerId}.json`));
  const checkpoint = await readFile(state.workers[second.workerId].checkpoint, 'utf8');
  const result = await f.supervisor.dispose({ workerId: second.workerId, stop: observed.stop,
    action: 'notify', kind: 'completion', evidence: 'Review complete with evidence.',
    reportHash: checkpointHash(checkpoint) });
  assert.match(result.content[0].text, /Material notice sent/);
  assert.equal(f.worker.messages.length, 0, 'other owner receives no reviewer notice, especially during user wait');
  assert.equal(other.messages.length, 1);
  const final = await f.state();
  assert.equal(final.ownerWaits[f.workerId()].kind, 'user');
  assert.equal(final.ownerWaits[Object.values(final.workers).find(w => w.coordinatorId ===
    final.workers[second.workerId].recipient.id).workerId], undefined);
  assert.equal(final.routes.w.paused, false);
  const otherOwnerId = Object.values(final.workers).find(w => w.coordinatorId ===
    final.workers[second.workerId].recipient.id).workerId;
  assert.equal(final.handled[otherOwnerId], ownerStop, 'delivered child notice cannot rearm the old owner stop');

  const writer = f.children[0].native;
  writer.assistant('Implementation complete with evidence.');
  await writer.emit('agent_settled');
  const writerStop = await readJson(join(f.root, `observation-${first.workerId}.json`));
  const writerCheckpoint = await readFile(final.workers[first.workerId].checkpoint, 'utf8');
  const deferred = await f.supervisor.dispose({ workerId: first.workerId, stop: writerStop.stop,
    action: 'notify', kind: 'completion', evidence: 'Implementation complete with evidence.',
    reportHash: checkpointHash(writerCheckpoint) });
  assert.match(deferred.content[0].text, /Material notice pending/);
  assert.equal(f.worker.messages.length, 0);
  assert.equal(other.messages.length, 1);
  assert.equal((await f.state()).routes.w.paused, false);

  await f.worker.command('continuation-owner', 'resume');
  assert.equal((await f.state()).ownerWaits[f.workerId()].kind, 'released');
  assert.equal(f.worker.messages.length, 0, 'explicit release does not preempt selected ordinary user input');
  assert.equal((await f.observation()).hold, false, 'owner confirmation is guarded, not an external approval hold');
  const pendingNotice = Object.values((await f.state()).notices).find(n => n.workerId === first.workerId);
  assert.equal(pendingNotice.status, 'pending');
  assert.equal((await readdir(f.root)).includes(`receipt-${pendingNotice.id}.json`), false,
    'no notice receipt may be claimed while a user selection is still pending');
  const staleRelease = await sendAction(f.root, { type: 'owner-wait', kind: 'settled-user',
    workerId: f.workerId(), coordinatorId: (await f.state()).workers[f.workerId()].coordinatorId,
    sessionId: f.worker.id, sessionFile: f.worker.file }, 'supervisor');
  assert.equal(staleRelease.accepted, false, 'without a fresh native owner stop, no direct release is accepted');
  assert.equal(f.worker.messages.length, 0);

  // Pi 1.5.2 stops after a later input handler returns handled, without a run.
  // sendUserMessage then emits extension input followed by messageType=user.
  await f.worker.emit('input', { source: 'interactive', text: 'Handled by another extension.' });
  await f.worker.emit('input', { source: 'extension', text: 'Synthetic housekeeping.' });
  await f.worker.emit('before_agent_start', { messageType: 'user', prompt: 'Synthetic housekeeping.' });
  await f.worker.emit('agent_start');
  f.worker.user('Synthetic housekeeping.');
  f.worker.assistant('Synthetic run finished; no selection was supplied.');
  await f.worker.emit('agent_settled');
  assert.equal((await f.state()).ownerWaits[f.workerId()].kind, 'released');
  assert.equal((await f.state()).notices[pendingNotice.id].status, 'pending');
  assert.equal(f.worker.messages.length, 0, 'extension-origin turn cannot release a user-decision wait');
  assert.equal((await readdir(f.root)).includes(`receipt-${pendingNotice.id}.json`), false);

  await f.worker.emit('input', { source: 'interactive', text: 'Fix all three selected findings.' });
  await f.worker.emit('before_agent_start', { messageType: 'user', prompt: 'Fix all three selected findings.' });
  await f.worker.emit('agent_start');
  f.worker.user('Fix all three selected findings.');
  assert.equal(f.worker.messages.length, 0, 'selection run must finish before material notice');
  f.worker.assistant('Selection recorded; will coordinate the bounded fixes.');
  await f.worker.emit('agent_settled');
  assert.equal(f.worker.messages.length, 1, 'the deferred notice delivers after the ordinary user turn');
  assert.equal((await f.state()).ownerWaits[f.workerId()], undefined);
  assert.equal(Object.values((await f.state()).notices).find(n => n.workerId === first.workerId)?.status, 'sent');
  assert.equal((await readJson(join(f.root, `receipt-${pendingNotice.id}.json`))).status, 'sent');
});

test('P5 read-only exact-task claims prevent duplicate dispatch under another key without relying on writer exclusion', async t => {
  const f = await fixture(t);
  await f.worker.command('continuation-delegate', 'read-only Inspect approved results without edits.');
  const assignment = { key: 'inspect-once', task: 'Inspect approved stage-one results without changes.', role: 'read-only' };
  await f.worker.spawn(assignment);
  await assert.rejects(f.worker.spawn({ ...assignment, key: 'same-task-another-key' }), /EEXIST/);
  assert.equal(f.effects.filter(e => e === 'task').length, 1);
});

test('P1/P3 no native scoped grant, cancelled grant, or copied session entry confers delegation authority', async t => {
  const f = await fixture(t);
  f.worker.user('We could brainstorm delegating an implementation someday.');
  await assert.rejects(f.worker.spawn(task), /No scoped delegation grant/);
  f.worker.confirm(false);
  await f.authorize();
  await assert.rejects(f.worker.spawn(task), /No scoped delegation grant/);
  f.worker.confirm(async () => {
    f.worker.raw('\r');
    await f.worker.emit('ui_prompt_start');
    await f.worker.emit('ui_prompt_end');
    return true;
  });
  await f.authorize();
  await assert.rejects(f.authorize('A different scope'), /Revoke the current delegation tree/);
  const replacement = await f.replaceWorker();
  for (const e of f.worker.entries.filter(e => e.customType === 'pi-continuation-delegation'))
    replacement.pi.appendEntry(e.customType, { ...e.data, sessionId: replacement.id });
  await assert.rejects(replacement.spawn(task), /another planning session|No scoped/);
  assert.deepEqual(f.effects, []);
});

test('P1 explicit read-only root scope cannot create a writer', async t => {
  const f = await fixture(t);
  await f.worker.command('continuation-delegate', 'read-only Inspect the approved implementation without edits.');
  await assert.rejects(f.worker.spawn(task), /Read-only delegates cannot create writers/);
  assert.deepEqual(f.effects, []);
  assert.equal((await f.attempts()).length, 0);
});

test('P7 writer claims follow verified Git checkout identity, not a parent cwd spelling', async t => {
  const f = await fixture(t, { splitLost: true });
  await f.authorize();
  await assert.rejects(f.worker.spawn(task), /held for inspection/);
  const parent = f.native('w:p2');
  parent.ctx.cwd = join(f.root, 'subdirectory');
  await mkdir(parent.ctx.cwd);
  f.agents.push({ ...f.agents[0], pane_id: 'w:p2', terminal_id: 'another-terminal', cwd: parent.ctx.cwd,
    agent_session: { ...f.agents[0].agent_session, value: parent.file } });
  await parent.emit('session_start', { reason: 'startup' });
  await parent.command('continuation-delegate', 'writer Implement another part of the same checkout.');
  await assert.rejects(parent.spawn({ ...task, key: 'another-parent', task: 'A different writer assignment' }), /held for inspection.*EEXIST/);
  assert.deepEqual(f.effects, ['split'], 'ambiguous original writer retains checkout ownership');
  assert.equal((await readdir(f.root)).filter(p => p.startsWith('delegation-writer-')).length, 1);
});

for (const unavailable of [true, false]) {
  test(`P7 writer exclusion ${unavailable ? 'holds an unverifiable existing checkout' : 'permits a verified unrelated checkout'}`, async t => {
    const f = await fixture(t);
    const existing = f.native('w:p2');
    existing.ctx.cwd = join(f.root, unavailable ? 'removed-subdirectory' : 'unrelated-checkout');
    await mkdir(existing.ctx.cwd);
    if (!unavailable) execFileSync('git', ['init', '--quiet', existing.ctx.cwd]);
    f.agents.push({ ...f.agents[0], pane_id: 'w:p2', terminal_id: 'existing-terminal', cwd: existing.ctx.cwd,
      agent_session: { ...f.agents[0].agent_session, value: existing.file } });
    await existing.emit('session_start', { reason: 'startup' });
    await existing.command('continuation-worker', 'start');
    const [binding] = Object.values((await f.state()).workers);
    assert.equal(binding.sessionId, existing.id);
    assert.equal(binding.paused, false);
    if (unavailable) await rm(existing.ctx.cwd, { recursive: true });
    await f.authorize();

    if (unavailable) {
      await assert.rejects(f.worker.spawn(task), /Existing worker checkout cannot be verified/);
      assert.deepEqual(f.effects, [], 'unknown checkout must reject before pane creation');
      assert.equal((await f.attempt()).status, 'held');
      assert.equal(Object.keys((await f.state()).workers).length, 1);
      assert.equal((await readdir(f.root)).some(p => p.startsWith('delegation-writer-')), false);
    } else {
      assert.equal((await f.worker.spawn(task)).details.status, 'dispatched');
      assert.deepEqual(f.effects, ['split', 'start', 'task']);
      assert.equal(Object.keys((await f.state()).workers).length, 2);
    }
  });
}

test('P4 owner restart retains route pause and refuses stale grant retargeting', async t => {
  const f = await fixture(t);
  await f.authorize();
  await f.supervisorCommand('pause global');
  await assert.rejects(f.worker.spawn(task), /Global continuation is paused/);
  assert.equal((await f.attempts()).length, 0);
  await f.supervisorCommand('activate global');
  const state = await f.state();
  state.routes.w = { paused: true, coordinator: null };
  // Own temporary state only; restart restores the independently paused route.
  await f.supervisor.emit('session_shutdown');
  await atomicJson(join(f.root, 'supervisor.json'), state);
  await f.supervisorCommand('start');
  await assert.rejects(f.worker.spawn(task), /supervisor changed/i, 'owner token changed: old grant cannot retarget');
  assert.equal((await f.state()).routes.w.paused, true);
  assert.deepEqual(f.effects, []);
});

test('P4 pause arriving after creation withholds enrollment/assignment, retains created pane and history', async t => {
  const f = await fixture(t, { afterStart: f => f.supervisorCommand('pause global') });
  await f.authorize();
  await assert.rejects(f.worker.spawn(task), /held for inspection/);
  assert.deepEqual(f.effects, ['split', 'start']);
  assert.equal(Object.keys((await f.state()).workers).length, 0);
  assert.equal((await f.attempt()).status, 'held');
  assert.equal((await f.state()).paused, true);
});

test('P3 Herdr-blocked unsupervised planning parent cannot spawn even without a native worker hold', async t => {
  const f = await fixture(t);
  await f.authorize();
  f.agents[0].agent_status = 'blocked';
  await assert.rejects(f.worker.spawn(task), /Parent Herdr identity\/status changed or blocked/);
  assert.deepEqual(f.effects, []);
  assert.equal((await f.attempts()).length, 0);
});

test('P3 native interaction in the newly created child prevents automatic enrollment and task delivery', async t => {
  const f = await fixture(t, { afterStart: (_f, child) => child.native.raw('\u001b') });
  await f.authorize();
  await assert.rejects(f.worker.spawn(task), /held for inspection/);
  assert.equal(Object.keys((await f.state()).workers).length, 0);
  assert.equal(f.effects.includes('task'), false);
});

test('P1/P7 exact owner/native identity mismatch cannot enroll an arbitrary existing pane', async t => {
  const f = await fixture(t, { afterStart: (_f, child) => { child.agent.agent_session.value = '/not-the-native-session.jsonl'; } });
  await f.authorize();
  await assert.rejects(f.worker.spawn(task), /held for inspection/);
  assert.equal(Object.keys((await f.state()).workers).length, 0);
  assert.equal(f.effects.includes('task'), false);
  const attempt = await f.attempt();
  assert.equal(attempt.status, 'held');
  const boot = await sendAction(f.root, { type: 'enroll', id: attempt.id }, attempt.id);
  assert.equal(boot.accepted, false, 'held attempt cannot be retried via bootstrap');
});

for (const boundary of ['splitLost', 'startLost']) {
  test(`P5/P7 ${boundary} is held and same key or duplicate task never repeats effects`, async t => {
    const f = await fixture(t, { [boundary]: true });
    await f.authorize();
    await assert.rejects(f.worker.spawn(task), /held for inspection/);
    const before = [...f.effects];
    assert.equal((await f.attempt()).status, 'held');
    await assert.rejects(f.worker.spawn(task), /EEXIST/);
    await assert.rejects(f.worker.spawn({ ...task, key: 'try-again' }), /EEXIST/);
    assert.deepEqual(f.effects, before);
    assert.equal(f.effects.includes('task'), false);
  });
}

test('P3/P4 held supervised parent and revoked authority cannot subdelegate', async t => {
  const f = await fixture(t);
  await f.authorize();
  const result = (await f.worker.spawn(task)).details;
  const child = f.children[0];
  child.native.raw('\u001b');
  // Await the native abort lifecycle, not a disk-speed-dependent sleep. The
  // synchronous local fence can reject before the durable hold is visible.
  await child.native.emit('agent_settled', { aborted: true });
  const held = await readJson(join(f.root, `observation-${result.workerId}.json`));
  assert.equal(held.hold, true);
  assert.equal(held.holdReason, 'interruption');
  const before = [...f.effects];
  await assert.rejects(child.native.spawn({ key: 'paused-sub', task: 'Inspect only', role: 'read-only' }), /paused or held/);
  assert.deepEqual(f.effects, before);
  await f.worker.command('continuation-delegate', 'revoke');
  await assert.rejects(f.worker.spawn({ key: 'revoked', task: 'Inspect another thing', role: 'read-only' }), /revoked/);
  assert.equal(f.children.length, 1);
});

for (const boundary of ['enroll', 'assignment']) {
  test(`P5/P7 lost ${boundary} response never repeats an accepted effect and fences continuation`, async t => {
    const f = await fixture(t);
    await f.authorize();
    const reference = f.worker.entries.find(e => e.customType === 'pi-continuation-delegation').data;
    const send = async (...args) => {
      const result = await sendAction(...args);
      if (args[1].type === boundary) throw new Error(`lost ${boundary} response after acceptance`);
      return result;
    };
    await assert.rejects(spawnDelegated({ root: f.root, socketPath: f.socketPath, paneId: 'w:p1',
      ctx: f.worker.ctx, reference, ...task, send }), /held for inspection/);
    const attempt = await f.attempt();
    assert.equal(attempt.status, 'held');
    assert.equal(Object.keys((await f.state()).workers).length, 1, 'accepted enrollment is retained');
    assert.equal(f.effects.filter(e => e === 'task').length, boundary === 'assignment' ? 1 : 0);
    await assert.rejects(f.worker.spawn(task), /EEXIST/);
    const child = f.children[0].native;
    // A normal-looking final reply must not make ambiguous startup resumable.
    child.assistant('Stage one is done; more approved work remains.');
    await child.emit('agent_settled', { aborted: false });
    await f.supervisorCommand('status');
    for (let i = 0; i < 50 && !Object.values((await f.state()).workers)[0].paused; i++)
      await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(Object.values((await f.state()).workers)[0].paused, true);
  });
}

test('P3 accepted message without a matching native run stays uncertain and cannot be resent', async t => {
  const f = await fixture(t, { suppressRun: true });
  await f.authorize();
  await assert.rejects(f.worker.spawn(task), /Assignment run was not observed/);
  const attempt = await f.attempt();
  assert.equal(attempt.status, 'held');
  assert.equal((await readJson(join(f.root, `spawn-receipt-${attempt.id}.json`))).status, 'accepted');
  await assert.rejects(f.worker.spawn(task), /EEXIST/);
  assert.equal(f.effects.filter(e => e === 'task').length, 1);
});

test('P3/P5 cancellation after pane creation and concurrent calls retain one attempt without duplicate effects', async t => {
  const controller = new AbortController();
  let signalCreated, releaseSplit;
  const paneCreated = new Promise(resolve => { signalCreated = resolve; });
  const splitResponse = new Promise(resolve => { releaseSplit = resolve; });
  const f = await fixture(t, { beforeSplit: async () => {
    controller.abort();
    signalCreated();
    await splitResponse;
  } });
  await f.authorize();
  const first = f.worker.spawn(task, controller.signal);
  // Make the cancellable caller own the claim before racing its duplicate.
  // If it fails before pane creation, surface that failure instead of hanging.
  await Promise.race([paneCreated, first]);
  const pending = Promise.allSettled([first, f.worker.spawn(task)]);
  releaseSplit();
  const results = await pending;
  assert.equal(results.every(r => r.status === 'rejected'), true);
  assert.match(results[0].reason.message, /held for inspection/);
  assert.equal(results[1].reason.code, 'EEXIST');
  assert.deepEqual(f.effects, ['split']);
  assert.equal((await f.attempt()).status, 'held');
});

test('P3 user finding selection remains a real decision disposition for a delegated worker', async t => {
  const f = await fixture(t);
  await f.authorize();
  const result = (await f.worker.spawn(task)).details;
  const child = f.children[0].native;
  const reply = 'Awaiting user finding selection: do not apply review fixes until the user chooses.';
  child.assistant(reply);
  await child.emit('agent_settled', { aborted: false });
  const observation = await readJson(join(f.root, `observation-${result.workerId}.json`));
  await f.supervisor.dispose({ workerId: result.workerId, stop: observation.stop,
    action: 'pause', evidence: reply });
  assert.equal((await f.state()).workers[result.workerId].paused, true);
  const count = f.effects.length;
  await f.supervisor.dispose({ workerId: result.workerId, stop: observation.stop,
    action: 'resume', evidence: reply });
  assert.equal(f.effects.length, count);
  assert.equal(child.messages.length, 0);
});

test('P3 continuation guidance preserves user finding selection instead of resuming review-driven fixes', () => {
  const guidance = attentionContent([]);
  assert.match(guidance, /Awaiting user finding selection is a genuine decision pause/);
  assert.match(guidance, /never resume to apply review findings before the user has selected them/);
  assert.match(delegationInstructions, /do not apply review findings or resume through that gate until the user selects them/);
});
