import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { startFixture } from './fixtures/start-flow.mjs';
import { readJson } from '../src/store.mjs';
import { sendAction } from '../src/ipc.mjs';
import { managedCheckpointText } from '../src/checkpoint.mjs';
import { checkpointHash } from '../src/policy.mjs';

const start = async f => {
  await f.supervisorCommand('start');
  await f.workerStart();
  assert.ok(f.workerId(), JSON.stringify(f.worker.notifications));
  assert.ok((await f.state()).workers[f.workerId()], JSON.stringify(f.worker.notifications));
};

async function turn(f, text, reply, { aborted = false, stopReason = 'stop' } = {}) {
  f.worker.raw(text);
  await f.worker.emit('input', { source: 'interactive', text });
  f.worker.user(text);
  await f.worker.emit('agent_start');
  f.worker.assistant(reply, stopReason);
  await f.worker.emit('agent_settled', { aborted });
}

const disposition = async (f, action, evidence) => {
  const observation = await f.observation();
  const state = await f.state();
  const checkpoint = await readFile(state.workers[f.workerId()].checkpoint, 'utf8');
  return f.supervisor.dispose({ workerId: f.workerId(), stop: observation.stop, action,
    evidence, reportHash: checkpointHash(checkpoint) });
};

test('start-only setup arms a blank worker, manages its checkpoint, and sends no task', { timeout: 10000 }, async t => {
  const f = await startFixture(t, { blank: true });
  await start(f);
  const state = await f.state(), binding = state.workers[f.workerId()];
  assert.equal(state.paused, false);
  assert.equal(state.acceptStarts, true);
  assert.equal(state.routes.w.paused, false);
  assert.equal(binding.paused, false);
  assert.equal(binding.paneId, 'w:p1');
  assert.equal(binding.sessionId, f.worker.id);
  const record = await readJson(join(f.root, `worker-${f.workerId()}.json`));
  assert.equal(record.managedInput, true);
  assert.equal(record.managedCheckpoint, true);
  assert.match(await readFile(binding.checkpoint, 'utf8'), /No task or result evidence yet/);
  assert.equal((await f.observation()).stop, null);
  assert.equal(f.worker.messages.length, 0);
  assert.equal(f.supervisor.confirmations.length, 1);
  assert.equal(f.worker.confirmations.length, 1);
});

test('ordinary submitted tasks remain supervised and reach one-use native continuation', { timeout: 10000 }, async t => {
  const f = await startFixture(t);
  await start(f);
  const initialStop = (await f.observation()).stop;
  await turn(f, 'Also complete the approved follow-up.', 'A concrete follow-up artifact was produced; the final approved step remains.');
  const observation = await f.observation();
  assert.equal(observation.hold, false);
  assert.equal(observation.outcome, 'completed');
  assert.notEqual(observation.stop, initialStop);
  assert.equal((await f.state()).workers[f.workerId()].paused, false);
  const evidence = 'A concrete follow-up artifact was produced; the final approved step remains.';
  assert.match((await disposition(f, 'resume', evidence)).content[0].text, /Continuation delivered/);
  assert.equal(f.worker.messages.length, 1);
  assert.match((await disposition(f, 'resume', evidence)).content[0].text, /already delivered/);
  assert.equal(f.worker.messages.length, 1);
  const state = await f.state();
  assert.equal(state.resumed[f.workerId()], observation.stop);
  assert.equal(state.budgets[f.workerId()].count, 1);
});

test('an input consumed before agent startup never re-exposes the previous stop', { timeout: 10000 }, async t => {
  const f = await startFixture(t);
  await start(f);
  const previous = await f.observation();
  f.worker.raw('handled elsewhere');
  await f.worker.emit('input', { source: 'interactive', text: 'handled elsewhere' });
  const observation = await f.observation();
  assert.equal(observation.stop, null);
  assert.equal(observation.hold, false);
  const response = await f.supervisor.dispose({ workerId: f.workerId(), stop: previous.stop,
    action: 'resume', evidence: previous.finalReply });
  assert.doesNotMatch(response.content[0].text, /^Continuation delivered$/);
  assert.equal(f.worker.messages.length, 0);
  assert.deepEqual((await f.state()).resumed, {});
});

test('growing managed history and repeated start cannot reset the two-nudge bound without new result evidence',
  { timeout: 10000 }, async t => {
    const f = await startFixture(t);
    await start(f);
    const evidence = 'Stage one produced the artifact. Stage two remains approved and unfinished.';
    assert.match((await disposition(f, 'resume', evidence)).content[0].text, /Continuation delivered/);
    await f.workerStart(); // Same report is still delivered, not a new opportunity.
    assert.match((await disposition(f, 'resume', evidence)).content[0].text, /already delivered/);
    await turn(f, 'Keep the existing approved scope.', evidence);
    assert.match((await disposition(f, 'resume', evidence)).content[0].text, /Continuation delivered/);
    await turn(f, 'The scope is unchanged.', evidence);
    assert.match((await disposition(f, 'resume', evidence)).content[0].text, /Two nudges/);
    assert.equal((await f.state()).budgets[f.workerId()].count, 2);
    assert.equal((await f.state()).workers[f.workerId()].paused, true);
    assert.equal(f.worker.messages.length, 2);
  });

test('Escape is sticky across normal text; confirmed start reassesses the same fresh report without resetting history',
  { timeout: 10000 }, async t => {
    const f = await startFixture(t);
    await start(f);
    f.worker.raw('\u001b');
    await turn(f, 'Here is more task context.', 'The concrete artifact is complete; approved follow-up remains.');
    const held = await f.observation();
    assert.equal(held.hold, true);
    assert.equal(held.holdReason, 'interruption');
    assert.match((await disposition(f, 'resume', 'approved follow-up remains')).content[0].text, /Report held/);
    assert.match((await disposition(f, 'pause', 'approved follow-up remains')).content[0].text, /Worker paused/);
    const before = await f.state();
    await f.workerStart();
    const after = await f.observation();
    assert.equal(after.stop, held.stop);
    assert.equal(after.finalReply, held.finalReply);
    assert.equal(after.outcome, 'completed');
    assert.equal(after.hold, false);
    assert.deepEqual((await f.state()).budgets, before.budgets);
    assert.deepEqual((await f.state()).resumed, before.resumed);
    assert.equal(f.worker.messages.length, 0);
    assert.match((await disposition(f, 'resume', 'approved follow-up remains')).content[0].text, /Continuation delivered/);
  });

test('returning after an idle Escape parks the unchanged nonce, not a newly minted resumable stop',
  { timeout: 10000 }, async t => {
    const f = await startFixture(t);
    await start(f);
    const before = await f.observation();
    f.worker.raw('\u001b');
    // The start command itself is not an input event in native Pi.
    await f.workerStart();
    const after = await f.observation();
    assert.equal(after.stop, before.stop);
    assert.equal(after.hold, false);
    assert.equal(after.finalReply, before.finalReply);
    assert.equal(f.worker.messages.length, 0);
  });

test('a repeated confirmed join cannot lift later worker/route/global pauses or spend/reset budgets',
  { timeout: 10000 }, async t => {
    const f = await startFixture(t);
    await start(f);
    const id = f.workerId(), record = await readJson(join(f.root, `worker-${id}.json`));
    const request = { type: 'worker-start', workerId: id, ...record.start };
    await f.supervisorCommand(`pause worker ${id}`);
    const paused = await f.state();
    const response = await sendAction(f.root, request, 'supervisor');
    assert.equal(response.accepted, true);
    assert.equal(response.workerPaused, true);
    assert.deepEqual(await f.state(), paused);
    await f.supervisorCommand('pause route w');
    await f.supervisorCommand('pause global');
    await f.workerStart(); // A new explicit opt-in enables only this worker.
    const state = await f.state();
    assert.equal(state.workers[id].paused, false);
    assert.equal(state.routes.w.paused, true);
    assert.equal(state.paused, true);
    assert.deepEqual(state.budgets, paused.budgets);
    assert.deepEqual(state.resumed, paused.resumed);
  });

test('start does not answer an unresolved user decision or generate another worker turn', { timeout: 10000 }, async t => {
  const f = await startFixture(t);
  await start(f);
  const question = 'The user must choose RED or BLUE; no choice has been authorized.';
  await turn(f, 'Record the choice without selecting either option.', question);
  await disposition(f, 'pause', question);
  const before = await f.observation();
  f.worker.raw('/continuation-worker start\r');
  await f.workerStart();
  const after = await f.observation();
  assert.equal(after.stop, before.stop);
  assert.equal(after.finalReply, question);
  assert.equal(f.worker.messages.length, 0);
  assert.deepEqual((await f.state()).resumed, {});
  assert.match((await disposition(f, 'pause', question)).content[0].text, /Worker paused/);
  assert.equal((await f.state()).workers[f.workerId()].paused, true);
});

for (const reason of ['prompt', 'error', 'abort']) test(`${reason} holds are not cleared by normal submitted text`,
  { timeout: 10000 }, async t => {
    const f = await startFixture(t);
    await start(f);
    if (reason === 'prompt') await f.worker.ctx.ui.confirm('Actual unrelated user approval?', 'Choose explicitly.');
    if (reason === 'error') await f.worker.emit('tool_execution_end', { isError: true });
    if (reason === 'abort') await f.worker.emit('agent_settled', { aborted: true });
    await turn(f, 'Additional context, not a return-to-supervision command.', 'This task still has pending work.');
    assert.equal((await f.observation()).hold, true);
    assert.equal(f.worker.messages.length, 0);
    assert.match((await disposition(f, 'resume', 'pending work')).content[0].text, /Report held/);
  });

test('missing/cancelled/self/forged starts activate nothing and replacement is never followed', { timeout: 10000 }, async t => {
  const f = await startFixture(t);
  await f.workerStart();
  assert.equal(f.workerId(), undefined);
  await f.supervisorCommand('start');
  await f.supervisor.command('continuation-worker', 'start');
  assert.deepEqual((await f.state()).workers, {});
  f.worker.confirm(false);
  await f.workerStart();
  assert.equal(f.workerId(), undefined);
  assert.equal((await readdir(f.root)).some(name => name.startsWith('checkpoint-')), false);
  const before = await f.state();
  const response = await sendAction(f.root, { type: 'worker-start', workerId: f.worker.id,
    nonce: f.worker.id, ownerToken: before.ownerToken }, 'supervisor');
  assert.equal(response.accepted, false);
  assert.deepEqual(await f.state(), before);
  f.worker.confirm(true);
  await f.workerStart();
  const id = f.workerId();
  assert.equal((await f.state()).workers[id].terminalId, 'terminal');
  f.agents[0].terminal_id = 'replacement-terminal';
  await f.workerStart();
  assert.equal((await f.state()).workers[id].terminalId, 'terminal');
  assert.equal((await f.observation()).hold, true);
  assert.equal(f.worker.messages.length, 0);
});

test('start refuses an existing foreign or unknown native registration rather than enrolling a second owner',
  { timeout: 10000 }, async t => {
    const f = await startFixture(t);
    await f.supervisorCommand('start');
    f.worker.pi.appendEntry('pi-continuation-worker', { workerId: f.worker.id,
      sessionId: f.worker.id, stateRoot: join(f.root, 'another-profile') });
    await f.workerStart();
    assert.deepEqual((await f.state()).workers, {});
    assert.equal((await readdir(f.root)).some(name => name.startsWith('checkpoint-')), false);
    assert.equal(f.worker.messages.length, 0);
  });

test('managed checkpoint persistence failure fences the worker instead of exposing stale successful evidence',
  { timeout: 10000 }, async t => {
    const f = await startFixture(t);
    await start(f);
    const state = await f.state(), path = state.workers[f.workerId()].checkpoint;
    await rm(path);
    await mkdir(path);
    f.worker.raw('another task');
    await f.worker.emit('input', { source: 'interactive', text: 'another task' });
    const observation = await f.observation();
    assert.equal(observation.hold, true);
    assert.equal(observation.outcome, 'error');
    assert.equal(observation.stop, null);
    assert.equal(f.worker.messages.length, 0);
  });

test('managed checkpoint uses native edited/compacted projection, excludes private payloads and does not invent evidence', () => {
  const messages = [
    { role: 'system', content: 'excluded-system' },
    { role: 'compactionSummary', summary: 'Earlier approved obligations remain.' },
    { role: 'user', content: [{ type: 'text', text: 'User follow-up after compaction.' }, { type: 'image', data: 'excluded-image' }] },
    { role: 'assistant', content: [{ type: 'thinking', thinking: 'excluded-thinking' }, { type: 'text', text: 'A concrete result.' }] },
    { role: 'toolResult', content: [{ type: 'text', text: 'excluded-tool' }] },
    { role: 'custom', customType: 'pi-continuation', content: 'excluded-resume-chatter' },
  ];
  const ctx = { sessionManager: { buildSessionProjection: () => ({ messages }),
    getBranch: () => assert.fail('Raw history must not override native context edits') } };
  const checkpoint = managedCheckpointText(ctx);
  assert.match(checkpoint, /Earlier approved obligations remain/);
  assert.match(checkpoint, /User follow-up after compaction/);
  assert.match(checkpoint, /A concrete result/);
  assert.match(checkpoint, /Image content omitted/);
  assert.doesNotMatch(checkpoint, /excluded-/);
  assert.equal(managedCheckpointText(ctx), checkpoint);
  assert.match(managedCheckpointText({ sessionManager: { buildSessionProjection: () => ({ messages: [] }) } }),
    /Await an actual user assignment/);
});
