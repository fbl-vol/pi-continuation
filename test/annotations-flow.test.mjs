import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startFixture } from './fixtures/start-flow.mjs';

async function until(predicate) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'Expected metadata did not arrive');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

test('ordinary owner publishes display-only Pause, Stop withdrawal and retained own-session Return', async t => {
  const f = await startFixture(t);
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
