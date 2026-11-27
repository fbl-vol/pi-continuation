import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { startFixture } from './fixtures/start-flow.mjs';
import { newSupervisor, decodeSupervisor } from '../src/contracts.mjs';
import { stopWorker, returnStoppedWorker, checkpointHash } from '../src/policy.mjs';
import { managementSnapshot } from '../src/management.mjs';
import { atomicJson, readJson } from '../src/store.mjs';
import { defaultDeliveryPreferences, readDeliveryPreferences } from '../src/preferences.mjs';
import { sendAction } from '../src/ipc.mjs';

async function started(t) {
  const f = await startFixture(t);
  await f.supervisorCommand('start');
  await f.workerStart();
  assert.ok(f.workerId());
  return f;
}

async function planningSession(f) {
  const planner = f.native('w:p2');
  f.agents.push({ ...f.agents[0], pane_id: 'w:p2',
    agent_session: { ...f.agents[0].agent_session, value: planner.file } });
  await planner.emit('session_start');
  return planner;
}

function snapshotPanes(f, panes) {
  f.onRequest(request => request.method === 'session.snapshot' ?
    { type: 'session_snapshot', snapshot: { protocol: 22, agents: f.agents, panes } } : undefined);
}

async function ownAction(f, action) {
  let step = 0;
  f.worker.select((_title, choices) => {
    const choice = step++ === 0 ? 'This session: details' : action;
    assert.ok(choices.includes(choice), JSON.stringify(choices));
    return choice;
  });
  await f.worker.command('continuation', '');
}

async function resume(f) {
  const observation = await f.observation();
  const binding = (await f.state()).workers[f.workerId()];
  return f.supervisor.dispose({ workerId: f.workerId(), stop: observation.stop,
    action: 'resume', evidence: observation.finalReply,
    reportHash: checkpointHash(await readFile(binding.checkpoint, 'utf8')) });
}

for (const interruption of ['none', 'earlier command', 'external prompt', 'Escape']) {
  test(`read-only menu restores only its own provisional hold (${interruption})`, async t => {
    const f = await started(t);
    const before = await f.observation();
    assert.equal(before.outcome, 'completed');
    let editor = interruption === 'earlier command' ? '/help' : '/continuation';
    f.worker.ctx.ui.getEditorText = () => editor;
    f.worker.raw('/');
    f.worker.raw('\r');
    if (interruption === 'earlier command') {
      editor = '/continuation';
      f.worker.raw('/');
      f.worker.raw('\r');
    }
    f.worker.select(async () => {
      await f.worker.continuation.flushObservations();
      assert.equal((await f.observation()).holdReason, 'typing');
      assert.equal((await f.observation()).stop, null);
      if (interruption === 'external prompt') await f.worker.ctx.ui.confirm('Actual user approval?');
      if (interruption === 'Escape') f.worker.raw('\u001b');
      return 'Close';
    });
    await f.worker.command('continuation', '');
    await f.worker.continuation.flushObservations();
    const after = await f.observation();
    if (interruption === 'none') {
      assert.equal(after.hold, false);
      assert.equal(after.stop, before.stop);
      assert.equal(after.finalReply, before.finalReply);
    } else {
      assert.equal(after.hold, true);
      assert.equal(after.holdReason, interruption === 'Escape' ? 'interruption' :
        interruption === 'earlier command' ? 'typing' : 'prompt');
    }
    assert.deepEqual(f.worker.messages, []);
  });
}

test('manual supervisor menu binds the exact pinned worker paused and activates only that worker', async t => {
  const f = await startFixture(t);
  const checkpoint = join(f.root, 'existing checkpoint.md');
  await writeFile(checkpoint, 'Remaining approved work.');
  await f.worker.continuation.registerPinned(f.worker.ctx, checkpoint);
  await f.supervisor.emit('session_start');
  const workerId = f.workerId();
  const menu = async (...actions) => {
    f.supervisor.select((_title, choices) => {
      const match = actions.shift();
      const action = typeof match === 'function' ? choices.find(match) : match;
      assert.ok(choices.includes(action), JSON.stringify(choices));
      return action;
    });
    await f.supervisor.command('continuation', '');
    assert.deepEqual(actions, []);
    assert.notEqual(f.supervisor.notifications.at(-1)?.[1], 'warning');
  };
  await menu('Claim supervisor for manual bindings');
  assert.equal((await f.state()).acceptStarts, false);
  assert.equal((await f.state()).paused, true);
  f.supervisor.answer(title => title.includes('worker ID') ? workerId : 'w');
  await menu('Manual supervisor controls', 'Bind a pinned worker');
  const bound = await f.state();
  assert.equal(bound.workers[workerId].sessionId, f.worker.id);
  assert.equal(bound.workers[workerId].checkpoint, checkpoint);
  assert.equal(bound.workers[workerId].paused, true);
  assert.equal(bound.routes.w.paused, true);
  await menu('Manual supervisor controls', 'Pause or activate a scope', 'Worker',
    label => label.endsWith(workerId), 'Activate');
  const active = await f.state();
  assert.equal(active.workers[workerId].paused, false);
  assert.equal(active.routes.w.paused, true);
  assert.equal(active.paused, true);
  assert.deepEqual(f.worker.messages, []);
});

test('delivery defaults save only the explicit draft and persist across menu openings', async t => {
  const f = await started(t);
  const planner = await planningSession(f);
  for (const ending of [undefined, 'Cancel']) {
    let step = 0;
    planner.select((_title, choices) => {
      const answer = ['Delivery preferences', 'Push branch: Ask First', 'Automatic', ending][step++];
      if (answer) assert.ok(choices.includes(answer), JSON.stringify(choices));
      return answer;
    });
    await planner.command('continuation', '');
    assert.deepEqual(await readDeliveryPreferences(f.root), defaultDeliveryPreferences());
    assert.equal((await readdir(f.root)).includes('delivery-preferences.json'), false);
  }
  let step = 0;
  planner.select((_title, choices) => {
    const answer = ['Delivery preferences', 'Push branch: Ask First', 'Automatic', 'Save'][step++];
    assert.ok(choices.includes(answer), JSON.stringify(choices));
    return answer;
  });
  await planner.command('continuation', '');
  assert.equal((await readDeliveryPreferences(f.root)).pushBranch, 'Automatic');
  // Opening the saved view also works after another Pi session reads this root.
  const other = f.native('w:p3');
  f.agents.push({ ...f.agents[0], pane_id: 'w:p3', terminal_id: 'new-session-terminal',
    agent_session: { ...f.agents[0].agent_session, value: other.file } });
  await other.emit('session_start');
  let opened = 0;
  other.select((_title, choices) => {
    if (opened++ === 0) return 'Delivery preferences';
    assert.ok(choices.includes('Push branch: Automatic'));
    return undefined;
  });
  await other.command('continuation', '');
});

test('delivery menu saves Automatic review fixes and Cancel keeps the saved value', async t => {
  const f = await started(t);
  const planner = await planningSession(f);
  let step = 0;
  planner.select((title, choices) => {
    if (step === 2) assert.match(title, /Human-selection rules and existing waits still apply/);
    if (step === 3) assert.ok(choices.includes('Fix review findings: Automatic'));
    const answer = ['Delivery preferences', 'Fix review findings: Ask First', 'Automatic', 'Save'][step++];
    assert.ok(choices.includes(answer), JSON.stringify(choices));
    return answer;
  });
  await planner.command('continuation', '');
  assert.equal((await readDeliveryPreferences(f.root)).fixReviewFindings, 'Automatic');
  step = 0;
  planner.select((_title, choices) => {
    const answer = ['Delivery preferences', 'Fix review findings: Automatic', 'Ask First', 'Cancel'][step++];
    assert.ok(choices.includes(answer));
    return answer;
  });
  await planner.command('continuation', '');
  assert.equal((await readDeliveryPreferences(f.root)).fixReviewFindings, 'Automatic');
});

test('the exact held worker clears its own report from /continuation without lifting supervision', async t => {
  const f = await started(t);
  await f.worker.emit('agent_start');
  f.worker.assistant('Interrupted before completion.');
  await f.worker.emit('agent_settled', { aborted: true });
  assert.equal((await f.observation()).hold, true);
  const prior = await f.state();
  f.agents[0].agent_status = 'working';
  f.worker.select((_title, choices) => {
    assert.ok(!choices.includes('Clear this session hold'));
    return undefined;
  });
  await f.worker.command('continuation', '');
  f.agents[0].agent_status = 'idle';
  f.worker.select((_title, choices) => {
    assert.ok(choices.includes('Clear this session hold'));
    return 'Clear this session hold';
  });
  await f.worker.command('continuation', '');
  assert.equal((await f.observation()).hold, false);
  assert.deepEqual((await f.state()).workers[f.workerId()], prior.workers[f.workerId()]);
  assert.equal(f.worker.confirmations.at(-1)[0], 'Clear worker hold?');
});

test('retained Stop withdraws the active row; own Return preserves identity, spent budget and consumed stop', async t => {
  const f = await started(t);
  assert.match((await resume(f)).content[0].text, /Continuation delivered/);
  const before = await f.state();
  const observed = await f.observation();
  const checkpoint = before.workers[f.workerId()].checkpoint;
  await ownAction(f, 'Stop supervising this worker');
  const stopped = await f.state();
  assert.equal(stopped.workers[f.workerId()].stopped, true, JSON.stringify(f.worker.notifications));
  assert.equal(stopped.workers[f.workerId()].paused, true);
  const view = await managementSnapshot(f.root, f.socketPath, f.worker.ctx);
  assert.equal(view.workers.filter(w => !w.binding.stopped).length, 0);
  assert.equal(view.own.status.label, 'Stopped');
  assert.deepEqual(stopped.budgets, before.budgets);
  assert.deepEqual(stopped.handled, before.handled);
  assert.deepEqual(stopped.resumed, before.resumed);
  assert.deepEqual(stopped.notices, before.notices);
  assert.equal((await f.observation()).hold, observed.hold);
  await assert.rejects(f.supervisorCommand(`activate worker ${f.workerId()}`), /own session/);
  await f.workerStart();
  const returned = await f.state();
  assert.equal(returned.workers[f.workerId()].stopped, undefined);
  assert.equal(returned.workers[f.workerId()].checkpoint, checkpoint);
  assert.equal(returned.workers[f.workerId()].sessionId, f.worker.id);
  assert.deepEqual(returned.retiredWorkers, {});
  for (const key of ['budgets', 'handled', 'resumed', 'notices', 'repair'])
    assert.deepEqual(returned[key], before[key], key);
  assert.match((await resume(f)).content[0].text, /already delivered/);
  assert.equal(f.worker.messages.length, 1);
});

test('Pause stays listed; Stop/Return preserves pre-existing worker, workspace and global pauses', async t => {
  const f = await started(t);
  await ownAction(f, 'Pause this worker');
  let view = await managementSnapshot(f.root, f.socketPath, f.worker.ctx);
  assert.equal(view.workers.filter(w => !w.binding.stopped).length, 1);
  assert.equal(view.own.status.label, 'Paused');
  await f.supervisorCommand('pause route w');
  await f.supervisorCommand('pause global');
  await ownAction(f, 'Stop supervising this worker');
  await f.workerStart();
  const state = await f.state();
  assert.equal(state.paused, true);
  assert.equal(state.routes.w.paused, true);
  assert.equal(state.workers[f.workerId()].paused, true);
  assert.equal(state.workers[f.workerId()].stopped, undefined);
});

test('Stop refuses a real accepted-but-uncertain continuation and retains its history', async t => {
  const f = await started(t);
  f.worker.pi.sendMessage = () => { throw new Error('synthetic recipient failure after acceptance'); };
  assert.match((await resume(f)).content[0].text, /Ambiguous/);
  const before = await f.state();
  assert.ok(before.inflight[f.workerId()]);
  await ownAction(f, 'Stop supervising this worker');
  const after = await f.state();
  assert.equal(after.workers[f.workerId()].stopped, undefined);
  assert.deepEqual(after.inflight, before.inflight);
  assert.match(f.worker.notifications.at(-1)[0], /Unresolved worker delivery/);
});

test('Stop ignores unrelated proved no-effect preflight refusal without deleting history', async t => {
  const f = await started(t);
  const id = '11111111-1111-1111-1111-111111111111';
  const path = join(f.root, `spawn-${id}.json`);
  const attempt = { id, status: 'preflight-refused', role: 'owner',
    parent: { sessionId: 'unrelated', sessionFile: join(f.root, 'other.jsonl') },
    preflightFailures: [{ at: new Date().toISOString(), reason: 'No effect requested' }] };
  await atomicJson(path, attempt);
  await ownAction(f, 'Stop supervising this worker');
  assert.equal((await f.state()).workers[f.workerId()].stopped, true);
  assert.deepEqual(await readJson(path), attempt);
});

test('Stop still refuses a related preflight refusal and an unrelated possible pane effect', async t => {
  const f = await started(t);
  const id = '11111111-1111-1111-1111-111111111111';
  const path = join(f.root, `spawn-${id}.json`);
  const attempt = { id, status: 'preflight-refused',
    parent: { sessionId: f.worker.id, sessionFile: f.worker.file } };
  await atomicJson(path, attempt);
  await ownAction(f, 'Stop supervising this worker');
  assert.equal((await f.state()).workers[f.workerId()].stopped, undefined);
  await atomicJson(path, { ...attempt, parent: { sessionId: 'other', sessionFile: join(f.root, 'other.jsonl') },
    paneRequested: true });
  await ownAction(f, 'Stop supervising this worker');
  assert.equal((await f.state()).workers[f.workerId()].stopped, undefined);
  assert.deepEqual(await readJson(path), { ...attempt,
    parent: { sessionId: 'other', sessionFile: join(f.root, 'other.jsonl') }, paneRequested: true });
});

test('Stop refuses retained uncertain delegated startup, without deleting its attempt', async t => {
  const f = await started(t);
  const id = '11111111-1111-1111-1111-111111111111';
  const path = join(f.root, `spawn-${id}.json`);
  const attempt = { id, status: 'held', parent: { sessionId: 'parent', sessionFile: join(f.root, 'parent.jsonl') },
    child: { sessionId: f.worker.id, sessionFile: f.worker.file } };
  await atomicJson(path, attempt);
  await ownAction(f, 'Stop supervising this worker');
  assert.equal((await f.state()).workers[f.workerId()].stopped, undefined);
  assert.match(f.worker.notifications.at(-1)[0], /Unresolved delegated startup/);
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), attempt);
});

test('an unsupervised planning session can pause the selected worker without activating or enrolling itself', async t => {
  const f = await started(t);
  const planner = await planningSession(f);
  planner.select((_title, choices) => choices.find(c => c.startsWith('1. ')) ?? 'Pause this worker');
  await planner.command('continuation', '');
  const state = await f.state();
  assert.equal(state.workers[f.workerId()].paused, true, JSON.stringify(planner.notifications));
  assert.equal(Object.keys(state.workers).length, 1);
  assert.equal(state.paused, false);
  assert.equal(state.routes.w.paused, false);
});

test('an own-session start confirmed before a concurrent Stop cannot automatically rejoin', async t => {
  const f = await started(t);
  const planner = await planningSession(f);
  planner.select((_title, choices) => choices.find(c => c.startsWith('1. ')) ?? 'Stop supervising this worker');
  f.worker.confirm(async () => {
    await planner.command('continuation', '');
    assert.equal((await f.state()).workers[f.workerId()].stopped, true);
    return true;
  });
  await f.workerStart();
  assert.equal((await f.state()).workers[f.workerId()].stopped, true);
  assert.match(f.worker.notifications.at(-1)[0], /fresh Start\/Return/);
  f.worker.confirm(true);
  await f.workerStart();
  assert.equal((await f.state()).workers[f.workerId()].stopped, undefined);
});

test('retained Stop refuses each unresolved notice state and never mutates history on refusal', () => {
  for (const status of ['pending', 'sending', 'uncertain']) {
    const state = newSupervisor();
    state.workers.worker = { paused: false, route: 'w' };
    state.notices.notice = { workerId: 'worker', status };
    const before = structuredClone(state);
    assert.throws(() => stopWorker(state, 'worker'), /Unresolved/);
    assert.deepEqual(state, before);
  }
});

test('stopped representation cannot decode as active or lose its prior pause', () => {
  const state = newSupervisor();
  state.workers.worker = { paused: false, route: 'w' };
  stopWorker(state, 'worker', '11111111-1111-1111-1111-111111111111');
  assert.equal(decodeSupervisor(state).workers.worker.stopped, true);
  assert.throws(() => decodeSupervisor({ ...state, workers: { worker: { ...state.workers.worker, paused: false } } }));
  const malformed = structuredClone(state);
  delete malformed.workers.worker.stoppedPaused;
  assert.throws(() => decodeSupervisor(malformed));
  returnStoppedWorker(state, 'worker');
  assert.equal(state.workers.worker.paused, false);
});

for (const cancel of ['selection', 'confirmation']) {
  test(`cancelled management ${cancel} has no control effect or saved intent`, async t => {
    const f = await started(t);
    const before = await f.state();
    if (cancel === 'confirmation') {
      f.worker.confirm(false);
      await ownAction(f, 'Stop supervising this worker');
    } else await f.worker.command('continuation', '');
    assert.deepEqual(await f.state(), before);
    assert.equal((await readdir(f.root)).some(name => /^management-/.test(name)), false);
  });
}

test('current pane labels are separate from retained closed and changed registrations', async t => {
  const f = await started(t);
  for (const pane of ['w:p3', 'w:p4']) {
    const past = f.native(pane);
    f.agents.push({ ...f.agents[0], pane_id: pane,
      agent_session: { ...f.agents[0].agent_session, value: past.file } });
    await past.emit('session_start');
    await past.continuation.start(past.ctx);
  }
  const planner = await planningSession(f);
  f.agents.splice(f.agents.findIndex(a => a.pane_id === 'w:p3'), 1);
  f.agents.find(a => a.pane_id === 'w:p4').agent_session = {
    source: 'herdr:pi', agent: 'pi', kind: 'path', value: join(f.root, 'replacement.jsonl') };
  f.agents[0].name = 'Generic agent name';
  f.agents[0].terminal_title_stripped = 'π - generic terminal title';
  snapshotPanes(f, [{ pane_id: 'w:p1', label: 'worker' }, { pane_id: 'w:p4', label: 'reused pane' }]);
  const before = await f.state();
  const menus = [];
  const answers = ['Previous / unavailable registrations (2)', '2. reused pane — Session changed', 'Details'];
  planner.select((title, choices) => { menus.push({ title, choices }); return answers[menus.length - 1]; });
  await planner.command('continuation', '');
  assert.deepEqual(menus[0].choices, ['Delivery preferences', 'Join this session to supervision', '1. worker — Supervised',
    'Previous / unavailable registrations (2)', 'Authorize scoped delegation', 'Register manual coordinator',
    'Register with an existing checkpoint', 'Close']);
  assert.match(menus[0].title, /Current workers \(1\)/);
  assert.equal(menus.length, 3);
  assert.equal(menus[1].title, 'Previous / unavailable registrations');
  assert.deepEqual(menus[1].choices, ['1. Worker — Pane closed', '2. reused pane — Session changed', 'Close']);
  assert.match(menus[2].title, /reused pane · Session changed/);
  assert.deepEqual(menus[2].choices, ['Details', 'Close']);
  assert.match(planner.notifications.at(-1)[0], /Session changed/);
  assert.deepEqual(await f.state(), before, 'browsing retained rows must not mutate supervision');
  assert.equal((await readdir(f.root)).some(name => /^management-/.test(name)), false);
});

test('a live pane without an agent is Session changed, not Pane closed; cancelling history has no effect', async t => {
  const f = await started(t);
  const planner = await planningSession(f);
  f.agents.splice(f.agents.findIndex(a => a.pane_id === 'w:p1'), 1);
  snapshotPanes(f, [{ pane_id: 'w:p1', label: 'shell now' }]);
  const before = await f.state();
  const menus = [];
  planner.select((title, choices) => {
    menus.push({ title, choices });
    return menus.length === 1 ? 'Previous / unavailable registrations (1)' : undefined;
  });
  await planner.command('continuation', '');
  assert.match(menus[0].title, /Current workers \(0\)/);
  assert.ok(!menus[0].choices.some(c => /^\d+\./.test(c)));
  assert.equal(menus.length, 2);
  assert.deepEqual(menus[1].choices, ['1. shell now — Session changed', 'Close']);
  assert.deepEqual(await f.state(), before);
  assert.equal((await readdir(f.root)).some(name => /^management-/.test(name)), false);
});

test('previous-registration browsing stays read-only if the original session reappears', async t => {
  const f = await started(t);
  const planner = await planningSession(f);
  const agent = f.agents.splice(f.agents.findIndex(a => a.pane_id === 'w:p1'), 1)[0];
  const before = await f.state();
  const menus = [];
  planner.select((title, choices) => {
    menus.push({ title, choices });
    if (menus.length === 1) return 'Previous / unavailable registrations (1)';
    if (menus.length === 2) { f.agents.push(agent); return choices[0]; }
    return 'Close';
  });
  await planner.command('continuation', '');
  assert.equal(menus.length, 3);
  assert.deepEqual(menus[2].choices, ['Details', 'Close']);
  assert.deepEqual(await f.state(), before);
});

test('missing observations stay in current workers and unnamed panes fall back to agent names', async t => {
  const f = await started(t);
  const planner = await planningSession(f);
  f.agents[0].name = 'Named agent';
  snapshotPanes(f, [{ pane_id: 'w:p1', label: '  ' }]);
  await writeFile(join(f.root, `observation-${f.workerId()}.json`), 'invalid-json');
  const menus = [];
  planner.select((title, choices) => { menus.push({ title, choices }); return 'Close'; });
  await planner.command('continuation', '');
  assert.equal(menus.length, 1);
  assert.match(menus[0].title, /Current workers \(1\)/);
  assert.ok(menus[0].choices.includes('1. Named agent — Status unknown'));
  assert.ok(!menus[0].choices.some(c => c.startsWith('Previous / unavailable')));
  assert.deepEqual(planner.notifications, []);
});

test('duplicate pane labels select only the addressed worker and preserve sibling settings', async t => {
  const f = await started(t);
  f.agents[0].name = 'Agent fallback';
  const other = f.native('w:p3');
  f.agents.push({ ...f.agents[0], pane_id: 'w:p3',
    agent_session: { ...f.agents[0].agent_session, value: other.file } });
  await other.emit('session_start');
  await other.continuation.start(other.ctx);
  const planner = await planningSession(f);
  snapshotPanes(f, [{ pane_id: 'w:p1', label: 'Same pane name' }, { pane_id: 'w:p3', label: 'Same pane name' }]);
  planner.select((_title, choices) => {
    const labels = choices.filter(c => /^\d+\./.test(c));
    if (!labels.length) return 'Pause this worker';
    assert.equal(labels.length, 2);
    assert.equal(new Set(labels).size, 2);
    assert.deepEqual(labels, ['1. Same pane name — Supervised', '2. Same pane name — Supervised']);
    return labels[1];
  });
  await planner.command('continuation', '');
  const state = await f.state();
  assert.equal(state.workers[f.workerId()].paused, false);
  assert.equal(Object.values(state.workers).find(w => w.sessionId === other.id).paused, true);
});

test('replacement while the selected-worker menu is open refuses the old target', async t => {
  const f = await started(t);
  const planner = await planningSession(f);
  planner.select(async (_title, choices) => {
    const row = choices.find(c => c.startsWith('1. '));
    if (row) return row;
    await f.replaceWorker();
    return 'Pause this worker';
  });
  await planner.command('continuation', '');
  assert.match(planner.notifications.at(-1)[0], /Selected session changed/);
  assert.equal(Object.keys((await f.state()).workers).length, 1);
});

test('owner replacement during the menu cannot redirect own Return or clear its hold', async t => {
  const f = await started(t);
  f.worker.raw('\u001b');
  await f.worker.emit('agent_settled', { aborted: true });
  f.worker.select(async () => {
    await f.supervisor.emit('session_shutdown');
    const next = f.native('s:p2');
    next.ctx.isIdle = () => false;
    await next.continuation.supervisor.command('start', next.ctx);
    return 'Return this session to supervision';
  });
  await f.worker.command('continuation', '');
  assert.match(f.worker.notifications.at(-1)[0], /Supervisor or selected session changed/);
  assert.equal((await f.observation()).hold, true);
});

test('corrupt observations stay visibly unknown without exposing raw record contents', async t => {
  const f = await started(t);
  await writeFile(join(f.root, `observation-${f.workerId()}.json`), 'private-sentinel-invalid-json');
  const view = await managementSnapshot(f.root, f.socketPath, f.worker.ctx);
  assert.equal(view.own.status.kind, 'unavailable');
  await ownAction(f, 'Details');
  assert.match(f.worker.notifications.at(-1)[0], /Observation unavailable/);
  assert.equal(f.worker.notifications.some(([message]) => message.includes('private-sentinel')), false);
});

test('a consumed native management intent cannot be replayed or changed into activation', async t => {
  const f = await started(t);
  await ownAction(f, 'Pause this worker');
  const name = (await readdir(f.root)).find(n => /^management-[a-f0-9-]{36}\.json$/.test(n));
  const intent = JSON.parse(await readFile(join(f.root, name), 'utf8'));
  const result = await sendAction(f.root, { type: 'management-control', id: intent.id,
    ownerToken: intent.ownerToken, action: 'activate', enabled: true }, 'supervisor');
  assert.equal(result.accepted, false);
  assert.equal((await f.state()).workers[f.workerId()].paused, true);
});

test('a concurrent external prompt invalidates management selection and keeps the immediate worker hold', async t => {
  const f = await started(t);
  f.worker.select(async () => {
    await f.worker.ctx.ui.input('Unrelated approval');
    return 'Return this session to supervision';
  });
  await f.worker.command('continuation', '');
  assert.equal(f.worker.continuation.hold, true);
  assert.equal((await f.state()).workers[f.workerId()].paused, false);
  assert.match(f.worker.notifications.at(-1)[0], /Session or prompt changed/);
  assert.equal((await readdir(f.root)).some(name => /^management-/.test(name)), false);
});

for (const unresolved of ['bootstrap', 'unverifiable spawn']) {
  test(`Stop refuses ${unresolved} without hiding retained uncertainty`, async t => {
    const f = await started(t);
    if (unresolved === 'bootstrap') {
      await atomicJson(join(f.root, `observation-${f.workerId()}.json`), {
        ...await f.observation(), outcome: 'unknown', stop: null, bootstrapPending: true, hold: true });
    } else {
      await atomicJson(join(f.root, 'spawn-11111111-1111-1111-1111-111111111111.json'), { status: 'held' });
    }
    await ownAction(f, 'Stop supervising this worker');
    assert.equal((await f.state()).workers[f.workerId()].stopped, undefined);
    assert.match(f.worker.notifications.at(-1)[0], /inspect before Stop/);
  });
}
