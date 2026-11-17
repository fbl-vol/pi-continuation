import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { startFixture } from './fixtures/start-flow.mjs';
import { atomicJson, readJson } from '../src/store.mjs';
import { sendAction } from '../src/ipc.mjs';
import { attentionContent } from '../src/attention.mjs';
import { delegationInstructions, spawnDelegated } from '../src/delegation.mjs';

async function fixture(t, options = {}) {
  const f = await startFixture(t, { blank: true });
  execFileSync('git', ['init', '--quiet', f.root]);
  await f.supervisorCommand('start');
  const effects = [], children = [];
  let serial = 0;
  f.onRequest(async request => {
    const { method, params } = request;
    if (method === 'pane.split') {
      effects.push('split');
      await options.beforeSplit?.(f);
      const id = `w:p${++serial + 10}`;
      const pane = { pane_id: id, terminal_id: `terminal-${id}`, workspace_id: 'w', tab_id: 'w:t1' };
      children.push({ pane, env: params.env });
      assert.equal(params.focus, false);
      assert.equal(params.cwd, f.root);
      if (options.splitLost) throw new Error('lost split response after creation');
      return { type: 'pane_created', pane };
    }
    if (method === 'agent.start') {
      effects.push('start');
      const child = children.find(c => c.pane.pane_id === params.pane_id);
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
      child.agent = { ...child.pane, agent: 'pi', cwd: f.root, agent_status: 'idle',
        interactive_ready: true, completion_seq: 1, state_change_seq: 1,
        agent_session: { source: 'herdr:pi', agent: 'pi', kind: 'path', value: native.file } };
      f.agents.push(child.agent);
      await native.emit('session_start', { reason: 'startup' });
      await options.afterStart?.(f, child);
      if (options.startLost) throw new Error('lost start response');
      return { type: 'agent_started', agent: child.agent, argv: ['pi'] };
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
  const f = await fixture(t, { beforeSplit: () => controller.abort() });
  await f.authorize();
  const results = await Promise.allSettled([f.worker.spawn(task, controller.signal), f.worker.spawn(task)]);
  assert.equal(results.every(r => r.status === 'rejected'), true);
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
