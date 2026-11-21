import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startFixture } from './fixtures/start-flow.mjs';
import { checkpointHash } from '../src/policy.mjs';
import { workerStatus } from '../src/status.mjs';

async function start(t) {
  const f = await startFixture(t);
  await f.supervisorCommand('start');
  await f.workerStart();
  assert.ok(f.workerId());
  return f;
}

async function status(f) {
  const state = await f.state();
  return workerStatus(state, state.workers[f.workerId()], f.agents[0], await f.observation()).label;
}

async function resume(f, evidence) {
  const state = await f.state(), observation = await f.observation();
  const checkpoint = await readFile(state.workers[f.workerId()].checkpoint, 'utf8');
  return f.supervisor.dispose({ workerId: f.workerId(), stop: observation.stop, action: 'resume',
    evidence, reportHash: checkpointHash(checkpoint) });
}

test('P2 a failed intermediate tool does not hold a normal settled report or bypass one-use delivery', async t => {
  const f = await start(t);
  await f.worker.emit('agent_start');
  await f.worker.emit('tool_execution_end', { isError: true, toolName: 'bash', toolCallId: 'lookup' });
  const working = await f.observation();
  assert.equal(working.hold, false);
  assert.equal(working.outcome, 'working');
  assert.equal(working.stop, null, 'A failed tool must not expose the inherited stop');
  const reply = 'The documentation lookup failed; the source established the contract. Stage two remains approved and unfinished.';
  f.worker.assistant(reply);
  await f.worker.emit('agent_settled', { aborted: false });
  assert.equal((await f.observation()).outcome, 'completed');
  assert.equal((await f.observation()).hold, false);
  assert.equal(await status(f), 'Supervised');
  assert.match((await resume(f, reply)).content[0].text, /Continuation delivered/);
  assert.match((await resume(f, reply)).content[0].text, /already delivered/);
  assert.equal(f.worker.messages.length, 1);
});

test('P3 a failed settled run stays held through successful tools, new turns and reload, with honest provenance', async t => {
  const f = await start(t);
  await f.worker.emit('agent_start');
  await f.worker.emit('tool_execution_end', { isError: true });
  f.worker.assistant('Provider request failed.', 'error');
  await f.worker.emit('agent_settled', { aborted: false });
  const failed = await f.observation();
  assert.equal(failed.hold, true);
  assert.equal(failed.outcome, 'error');
  assert.equal(failed.holdError.kind, 'run');
  assert.ok(Number.isFinite(Date.parse(failed.holdError.at)));
  assert.equal(await status(f), 'Held: run failed');
  await f.worker.emit('tool_execution_end', { isError: false });
  await f.worker.emit('agent_start');
  f.worker.assistant('A later successful turn is not permission to clear the prior hold.');
  await f.worker.emit('agent_settled', { aborted: false });
  await f.worker.emit('session_shutdown');
  await f.worker.emit('session_start', { reason: 'reload' });
  assert.equal((await f.observation()).hold, true);
  assert.deepEqual((await f.observation()).holdError, failed.holdError);
  assert.equal(await status(f), 'Held: run failed');
  assert.match((await resume(f, 'unfinished work')).content[0].text, /Report held/);
  assert.equal(f.worker.messages.length, 0);
});

test('P3 observed approval still holds when followed by a tool failure and normal final reply', async t => {
  const f = await start(t);
  await f.worker.emit('agent_start');
  await f.worker.ctx.ui.confirm('Approval required?', 'An explicit user decision is required.');
  await f.worker.emit('tool_execution_end', { isError: true });
  await f.worker.emit('tool_execution_end', { isError: false });
  f.worker.assistant('Work remains, but the decision is still required.');
  await f.worker.emit('agent_settled', { aborted: false });
  const held = await f.observation();
  assert.equal(held.hold, true);
  assert.equal(held.holdReason, 'prompt');
  assert.equal(await status(f), 'Held: prompt');
  assert.match((await resume(f, 'unfinished work')).content[0].text, /Report held/);
  assert.equal(f.worker.messages.length, 0);
});

test('P3 failed checkpoint persistence remains held and has a separate cause', async t => {
  const f = await start(t);
  const checkpoint = (await f.state()).workers[f.workerId()].checkpoint;
  await rm(checkpoint);
  await mkdir(checkpoint);
  await f.worker.emit('agent_start');
  const held = await f.observation();
  assert.equal(held.hold, true);
  assert.equal(held.holdError.kind, 'checkpoint');
  assert.equal(await status(f), 'Held: checkpoint');
  assert.equal(f.worker.continuation.registered, false);
  assert.equal(f.worker.messages.length, 0);
});

test('P3/P7 a managed checkpoint failure recovers on reload only after writing the same settled report', async t => {
  const f = await start(t);
  await f.worker.emit('agent_start');
  const checkpoint = (await f.state()).workers[f.workerId()].checkpoint;
  await rm(checkpoint);
  await mkdir(checkpoint);
  const reply = 'Stage one is complete. Stage two remains approved and unfinished.';
  f.worker.assistant(reply);
  await f.worker.emit('agent_settled', { aborted: false });
  const failed = await f.observation();
  assert.equal(failed.holdError.kind, 'checkpoint');
  assert.equal(failed.hold, true);
  assert.equal(f.worker.continuation.registered, false);
  assert.equal(f.worker.messages.length, 0);

  await f.worker.emit('session_shutdown');
  await rm(checkpoint, { recursive: true });
  await f.worker.emit('session_start', { reason: 'reload' });
  const recovered = await f.observation();
  assert.equal(recovered.hold, false);
  assert.equal(recovered.outcome, 'completed');
  assert.equal(recovered.stop, failed.checkpointRecovery.report.stop);
  assert.equal(recovered.finalReply, reply);
  assert.match(await readFile(checkpoint, 'utf8'), /Stage two remains approved/);
  assert.equal(await status(f), 'Supervised');
  assert.equal(f.worker.messages.length, 0, 'Recovery only enables reassessment');
  assert.match((await resume(f, reply)).content[0].text, /Continuation delivered/);
  assert.equal(f.worker.messages.length, 1);
});

test('P3/P7 a still-unwritable managed checkpoint never releases its report', async t => {
  const f = await start(t);
  await f.worker.emit('agent_start');
  const checkpoint = (await f.state()).workers[f.workerId()].checkpoint;
  await rm(checkpoint);
  await mkdir(checkpoint);
  f.worker.assistant('Stage two remains unfinished.');
  await f.worker.emit('agent_settled', { aborted: false });
  const failed = await f.observation();
  await f.worker.emit('session_shutdown');
  await f.worker.emit('session_start', { reason: 'reload' });
  assert.equal((await f.observation()).hold, true);
  assert.equal((await f.observation()).checkpointRecovery.report.stop, failed.checkpointRecovery.report.stop);
  assert.equal(f.worker.continuation.registered, false);
  assert.equal(f.worker.messages.length, 0);
});

test('P3/P4 an explicit worker pause after a checkpoint failure survives a successful rewrite', async t => {
  const f = await start(t);
  await f.worker.emit('agent_start');
  const checkpoint = (await f.state()).workers[f.workerId()].checkpoint;
  await rm(checkpoint);
  await mkdir(checkpoint);
  f.worker.assistant('Stage two remains approved and unfinished.');
  await f.worker.emit('agent_settled', { aborted: false });
  await f.supervisorCommand(`pause worker ${f.workerId()}`);
  assert.equal((await f.state()).workers[f.workerId()].reason, 'Explicit worker pause');

  await f.worker.emit('session_shutdown');
  await rm(checkpoint, { recursive: true });
  await f.worker.emit('session_start', { reason: 'reload' });
  assert.equal((await f.observation()).hold, false, 'The exact checkpoint is durable again');
  assert.equal((await f.state()).workers[f.workerId()].paused, true);
  const state = await f.state();
  assert.equal(state.workers[f.workerId()].reason, 'Explicit worker pause');
  const observation = await f.observation();
  assert.equal(workerStatus(state, { ...state.workers[f.workerId()],
    failure: { operation: 'read checkpoint' } }, f.agents[0], observation).label, 'Paused',
    'A retained supervisor checkpoint diagnostic cannot override a healthy report and explicit pause');
  assert.equal(await status(f), 'Paused');
  assert.equal(f.worker.messages.length, 0);
});

test('P3/P7 a changed native report cannot heal a retained checkpoint hold', async t => {
  const f = await start(t);
  await f.worker.emit('agent_start');
  const checkpoint = (await f.state()).workers[f.workerId()].checkpoint;
  await rm(checkpoint);
  await mkdir(checkpoint);
  f.worker.assistant('The approved work is unfinished.');
  await f.worker.emit('agent_settled', { aborted: false });
  await f.worker.emit('session_shutdown');
  await rm(checkpoint, { recursive: true });
  f.worker.assistant('A different report cannot authorize the old stop.');
  await f.worker.emit('session_start', { reason: 'reload' });
  assert.equal((await f.observation()).hold, true);
  assert.equal((await f.observation()).holdError.kind, 'checkpoint');
  assert.equal(await status(f), 'Held: checkpoint');
  assert.equal(f.worker.messages.length, 0);
});

for (const originalCause of ['prompt', 'run', 'checkpoint', 'legacy']) {
  test(`P3/P7 a later failed turn preserves the original ${originalCause} hold in Details and reload`, async t => {
    const f = await start(t);
    if (originalCause === 'legacy') {
      const legacy = { ...await f.observation(), hold: true, holdReason: 'error', outcome: 'approval' };
      await writeFile(join(f.root, `observation-${f.workerId()}.json`), JSON.stringify(legacy));
    } else if (originalCause === 'checkpoint') {
      const checkpoint = (await f.state()).workers[f.workerId()].checkpoint;
      await rm(checkpoint);
      await mkdir(checkpoint);
      await f.worker.emit('agent_start');
      assert.equal(f.worker.continuation.registered, false);
      // Restore only this fixture's writable checkpoint, not its retained hold.
      await rm(checkpoint, { recursive: true });
      await writeFile(checkpoint, 'The approved assignment remains unfinished.');
    } else {
      await f.worker.emit('agent_start');
      if (originalCause === 'prompt')
        await f.worker.ctx.ui.confirm('Approval required?', 'An explicit decision is still needed.');
      f.worker.assistant('Original turn result.', originalCause === 'run' ? 'error' : 'stop');
      await f.worker.emit('agent_settled', { aborted: false });
    }
    await f.worker.emit('session_shutdown');
    const original = await f.observation();
    // A fixed retained timestamp makes overwrite detection independent of clock resolution.
    if (original.holdError) original.holdError.at = '2026-01-01T12:00:00.000Z';
    await writeFile(join(f.root, `observation-${f.workerId()}.json`), JSON.stringify(original));
    await f.worker.emit('session_start', { reason: 'reload' });
    await f.worker.emit('agent_start');
    f.worker.assistant('A later provider request failed.', 'error');
    await f.worker.emit('agent_settled', { aborted: false });
    await f.worker.emit('session_shutdown');
    await f.worker.emit('session_start', { reason: 'reload' });

    const held = await f.observation();
    assert.equal(held.outcome, 'error', 'The latest report still records the failed run');
    assert.equal(held.hold, true);
    assert.equal(held.holdReason, original.holdReason);
    assert.deepEqual(held.holdError, original.holdError);
    const expectedLabel = { prompt: 'Held: prompt', run: 'Held: run failed',
      checkpoint: 'Held: checkpoint', legacy: 'Held: error' }[originalCause];
    assert.equal(await status(f), expectedLabel);
    const inspector = f.native('planner:p1');
    await inspector.emit('session_start');
    inspector.select((_title, choices) => choices.find(choice => choice.startsWith('1. ')) ?? 'Details');
    await inspector.command('continuation', '');
    const details = inspector.notifications.at(-1)[0];
    assert.ok(details.includes(expectedLabel));
    if (original.holdError) assert.ok(details.includes(`Hold recorded: ${original.holdError.at}`));
    else assert.doesNotMatch(details, /Hold recorded:/);
    if (originalCause === 'legacy') assert.match(details, /Cause\/time unavailable/);
    // Checkpoint failure can also pause the worker before report assessment.
    const refusal = originalCause === 'checkpoint' ? /Report held|^Paused$/ : /Report held/;
    assert.match((await resume(f, 'unfinished work')).content[0].text, refusal);
    assert.equal(f.worker.messages.length, 0);
  });
}

test('management details explain a run hold without raw tool payloads or changing its evidence', async t => {
  const f = await start(t);
  await f.worker.emit('agent_start');
  f.worker.assistant('Synthetic provider failure.', 'error');
  await f.worker.emit('agent_settled', { aborted: false });
  const before = await f.observation();
  const inspector = f.native('planner:p1');
  await inspector.emit('session_start');
  inspector.select((_title, choices) => choices.find(choice => choice.startsWith('1. ')) ?? 'Details');
  await inspector.command('continuation', '');
  const text = inspector.notifications.at(-1)[0];
  assert.match(text, /Held: run failed/);
  assert.match(text, /Cause: a Pi turn ended in error/);
  assert.ok(text.includes(`Hold recorded: ${before.holdError.at}`));
  assert.match(text, /Start\/Return or Clear this session hold in \/continuation/);
  assert.doesNotMatch(text, /Synthetic provider failure/);
  assert.deepEqual(await f.observation(), before);
  assert.equal(f.worker.messages.length, 0);
});

test('P7 an old unclassified error hold remains held without fabricated provenance after reload', async t => {
  const f = await start(t);
  await f.worker.emit('session_shutdown');
  const path = join(f.root, `observation-${f.workerId()}.json`);
  const prior = { ...await f.observation(), hold: true, holdReason: 'error', outcome: 'approval' };
  delete prior.holdError;
  await writeFile(path, JSON.stringify(prior));
  await f.worker.emit('session_start', { reason: 'reload' });
  await f.worker.emit('agent_start');
  await f.worker.emit('tool_execution_end', { isError: true });
  f.worker.assistant('A successful turn must not silently repair an existing hold.');
  await f.worker.emit('agent_settled', { aborted: false });
  assert.equal((await f.observation()).hold, true);
  assert.equal((await f.observation()).holdError, undefined);
  assert.equal(await status(f), 'Held: error');
  assert.match((await resume(f, 'unfinished work')).content[0].text, /Report held/);
  assert.equal(f.worker.messages.length, 0);
});
