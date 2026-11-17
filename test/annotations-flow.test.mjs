import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { checkpointHash } from '../src/policy.mjs';
import { startFixture } from './fixtures/start-flow.mjs';

function showOwner(f) {
  const owner = { ...f.agents[0], pane_id: 's:p1', terminal_id: 'supervisor-terminal',
    workspace_id: 's', tab_id: 's:t1',
    agent_session: { ...f.agents[0].agent_session, value: f.supervisor.file } };
  f.agents.push(owner);
  return owner;
}

async function until(predicate) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'Expected metadata did not arrive');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

test('ordinary owner publishes display-only Pause, Stop withdrawal and retained own-session Return', async t => {
  const f = await startFixture(t);
  showOwner(f);
  const frames = [];
  f.onRequest(req => {
    if (req.method.endsWith('.report_metadata')) { frames.push(req); return { type: 'ok' }; }
  });
  const worker = () => frames.filter(r => r.method === 'pane.report_metadata' && r.params.pane_id === 'w:p1').at(-1);
  const workspace = () => frames.filter(r => r.method === 'workspace.report_metadata' && r.params.workspace_id === 'w').at(-1);
  await f.supervisorCommand('start');
  await f.workerStart();
  await until(() => worker()?.params.tokens.pi_continuation === 'Supervised');
  await until(() => workspace()?.params.tokens.pi_continuation_summary === '1 worker');
  await f.supervisorCommand(`pause worker ${f.workerId()}`);
  await until(() => worker()?.params.tokens.pi_continuation === 'Paused');
  let step = 0;
  f.worker.select((_title, choices) => {
    const choice = step++ === 0 ? 'This session: details' : 'Stop supervising this worker';
    assert.ok(choices.includes(choice));
    return choice;
  });
  await f.worker.command('continuation', '');
  await until(() => worker()?.params.tokens.pi_continuation === null);
  await until(() => workspace()?.params.tokens.pi_continuation_summary === null);
  assert.equal((await f.state()).workers[f.workerId()].stopped, true);
  await f.workerStart();
  await until(() => worker()?.params.tokens.pi_continuation === 'Paused');
  await until(() => workspace()?.params.tokens.pi_continuation_summary === '1 worker · 1 paused');
  const returned = await f.state();
  assert.equal(returned.workers[f.workerId()].stopped, undefined);
  assert.equal(returned.workers[f.workerId()].paused, true);
  assert.equal(f.worker.messages.length, 0);
  const beforeShutdown = frames.length;
  await f.supervisor.emit('session_shutdown');
  assert.ok(frames.slice(beforeShutdown).every(r => Object.values(r.params.tokens).every(v => v === null)));
  assert.ok(frames.slice(beforeShutdown).length >= 2);
});

test('shutdown withdraws the authority subscription before waiting for slow optional metadata cleanup', { timeout: 10000 }, async t => {
  const f = await startFixture(t);
  showOwner(f);
  let subscription, entered, release, failed;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const metadataFailure = new Promise(resolve => { failed = () => resolve('metadata failure'); });
  const notify = f.supervisor.ctx.ui.notify;
  f.supervisor.ctx.ui.notify = (...args) => {
    notify(...args);
    if (args[0].includes('Continuation annotations:')) failed();
  };
  let held = false;
  f.onRequest(async (req, socket) => {
    if (req.method === 'events.subscribe') subscription = socket;
    if (req.method.endsWith('.report_metadata')) {
      if (!held) { held = true; entered(); await gate; }
      return { type: 'ok' };
    }
  });
  await f.supervisorCommand('start');
  await f.workerStart();
  await started;
  const withdrawn = new Promise(resolve => subscription.once('close', () => resolve('withdrawn')));
  const closing = f.supervisor.emit('session_shutdown');
  try { assert.equal(await Promise.race([withdrawn, metadataFailure]), 'withdrawn'); }
  finally { release(); await closing; }
});

for (const identity of ['missing', 'mismatched']) {
  test(`initial ${identity} native owner disables annotations, not ordinary supervision`, async t => {
    const f = await startFixture(t);
    if (identity === 'mismatched') showOwner(f).agent_session.value = join(f.root, 'another-owner.jsonl');
    const frames = [];
    f.onRequest(req => {
      if (req.method.endsWith('.report_metadata')) { frames.push(req); return { type: 'ok' }; }
    });
    await f.supervisorCommand('start');
    await f.workerStart();
    const before = await f.state();
    const binding = before.workers[f.workerId()];
    assert.equal(before.paused, false);
    assert.equal(binding.paused, false);
    assert.equal(before.routes[binding.route].paused, false);
    const observed = await f.observation();
    const answer = await f.supervisor.dispose({ workerId: f.workerId(), stop: observed.stop,
      action: 'resume', evidence: observed.finalReply,
      reportHash: checkpointHash(await readFile(binding.checkpoint, 'utf8')) });
    assert.match(answer.content[0].text, /Continuation delivered to exact native stop/);
    const after = await f.state();
    assert.equal(after.ownerToken, before.ownerToken);
    assert.equal(after.paused, false);
    assert.equal(after.workers[f.workerId()].paused, false);
    assert.equal(after.routes[binding.route].paused, false);
    assert.equal(after.resumed[f.workerId()], observed.stop);
    assert.equal(f.worker.messages.length, 1);
    await f.supervisor.emit('session_shutdown'); // Drain display work before asserting absence.
    assert.deepEqual(frames, [], 'No owner witness means no pane or workspace reports');
    assert.equal(f.supervisor.notifications.some(([text]) => text.startsWith('Continuation annotations:')), false);
  });
}
