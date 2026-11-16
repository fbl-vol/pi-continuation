import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startFixture } from './fixtures/start-flow.mjs';
import { atomicJson, readJson } from '../src/store.mjs';
import { sendAction } from '../src/ipc.mjs';
import { accept } from '../src/receiver.mjs';

async function replacementFixture(t) {
  const f = await startFixture(t);
  await f.supervisorCommand('start');
  await f.workerStart();
  const oldId = f.workerId(), oldWorker = f.worker;
  const binding = (await f.state()).workers[oldId];
  const checkpoint = await readFile(binding.checkpoint, 'utf8');
  await f.replaceWorker();
  return { f, oldId, oldWorker, binding, checkpoint };
}

async function restoreState(f, change) {
  await f.supervisor.emit('session_shutdown');
  const state = await f.state();
  change(state);
  await atomicJson(join(f.root, 'supervisor.json'), state);
  await f.supervisorCommand('start');
}

test('start confirms retirement of a replaced pane session, preserves history and fences old registration', { timeout: 10000 }, async t => {
  const { f, oldId, oldWorker, binding, checkpoint } = await replacementFixture(t);
  await restoreState(f, state => {
    state.handled[oldId] = 'old-stop';
    state.resumed[oldId] = 'old-stop';
    state.budgets[oldId] = { count: 2, hash: 'old-hash', checkpoint: 'old evidence' };
    state.dispositions[oldId] = { stop: 'old-stop', action: 'pause' };
  });
  await f.supervisorCommand('pause route w');
  await f.supervisorCommand('pause global');
  const before = await f.state();
  // Native confirmation keys also reach onTerminalInput, unlike our fake UI.
  f.worker.confirm(title => {
    if (title.startsWith('Retire')) f.worker.raw('\r');
    return true;
  });
  await f.workerStart();
  const id = f.workerId(), state = await f.state();
  assert.notEqual(id, oldId);
  assert.equal(f.worker.confirmations.length, 2);
  assert.match(f.worker.confirmations[1][0], /Retire.*registration/);
  assert.match(f.worker.confirmations[1][1], new RegExp(oldId));
  assert.equal(state.workers[oldId], undefined);
  assert.equal(state.retiredWorkers[oldId].retiredBy, id);
  assert.equal(state.retiredWorkers[oldId].sessionId, binding.sessionId);
  assert.equal(state.retiredWorkers[oldId].paused, true);
  assert.equal(state.workers[id].sessionId, f.worker.id);
  assert.equal(state.workers[id].paused, false);
  assert.equal(state.paused, true);
  assert.equal(state.routes.w.paused, true);
  for (const key of ['handled', 'resumed', 'budgets', 'dispositions']) {
    assert.deepEqual(state[key][oldId], before[key][oldId]);
    assert.equal(state[key][id], undefined);
  }
  assert.equal(await readFile(binding.checkpoint, 'utf8'), checkpoint);
  assert.equal(f.worker.messages.length, 0);
  assert.equal(oldWorker.messages.length, 0);
  const rejected = await accept(f.root, { workerId: oldId }, { id: randomUUID() }, oldWorker.ctx, oldWorker.pi);
  assert.equal(rejected.accepted, false);
  assert.equal(oldWorker.messages.length, 0);
  const record = await readJson(join(f.root, `worker-${id}.json`));
  const replay = await sendAction(f.root, { type: 'worker-start', workerId: id, ...record.start }, 'supervisor');
  assert.equal(replay.accepted, true);
  assert.deepEqual(await f.state(), state);

  await assert.rejects(f.supervisorCommand(`add ${oldId} w`), { code: 'WORKER_RETIRED' });
  assert.equal((await f.state()).workers[oldId], undefined);
  await f.supervisor.emit('session_shutdown');
  await f.supervisorCommand('start');
  assert.equal((await f.state()).retiredWorkers[oldId].retiredBy, id);
});

test('cancelling replacement leaves the old binding and all history intact', { timeout: 10000 }, async t => {
  const { f, oldId } = await replacementFixture(t);
  f.worker.confirm(title => !title.startsWith('Retire'));
  await f.workerStart();
  const state = await f.state();
  assert.ok(state.workers[oldId]);
  assert.equal(state.workers[f.workerId()], undefined);
  assert.deepEqual(state.retiredWorkers, {});
  assert.equal((await f.observation()).hold, true);
  assert.equal(f.worker.messages.length, 0);
});

test('confirmed replacement refuses an old session still reported in another pane', { timeout: 10000 }, async t => {
  const { f, oldId, oldWorker } = await replacementFixture(t);
  f.agents.push({ ...f.agents[0], pane_id: 'w:p2', terminal_id: 'other',
    agent_session: { ...f.agents[0].agent_session, value: oldWorker.file } });
  await f.workerStart();
  assert.ok((await f.state()).workers[oldId]);
  assert.equal((await f.state()).workers[f.workerId()], undefined);
  assert.ok(f.worker.notifications.some(([text]) => /old session.*live/i.test(text)));
  assert.equal(f.worker.confirmations.length, 1);
});

test('replacement refuses unresolved resume or pending/uncertain notice delivery even when old worker is paused', { timeout: 20000 }, async t => {
  for (const kind of ['resume', 'pending', 'sending', 'uncertain']) {
    await t.test(kind, async t => {
      const { f, oldId } = await replacementFixture(t);
      await restoreState(f, state => {
        state.workers[oldId].paused = true;
        if (kind === 'resume') state.inflight[oldId] = { id: randomUUID(), stop: 'old-stop' };
        else {
          const id = randomUUID();
          state.notices[id] = { id, workerId: oldId, route: 'w', kind: 'blocker', text: 'needs inspection', status: kind };
        }
      });
      await f.workerStart();
      assert.ok((await f.state()).workers[oldId]);
      assert.equal((await f.state()).workers[f.workerId()], undefined);
      assert.ok(f.worker.notifications.some(([text]) => /delivery.*inspection/i.test(text)));
      assert.equal(f.worker.confirmations.length, 1);
    });
  }
});

test('replacement revalidates live identity after confirmation instead of trusting the preview', { timeout: 10000 }, async t => {
  const { f, oldId, oldWorker } = await replacementFixture(t);
  f.worker.confirm(title => {
    if (title.startsWith('Retire')) f.agents.push({ ...f.agents[0], pane_id: 'w:p2',
      agent_session: { ...f.agents[0].agent_session, value: oldWorker.file } });
    return true;
  });
  await f.workerStart();
  assert.ok((await f.state()).workers[oldId]);
  assert.equal((await f.state()).workers[f.workerId()], undefined);
  assert.equal((await f.observation()).hold, true);
  assert.equal(f.worker.confirmations.length, 2);
  assert.ok(f.worker.notifications.some(([text]) => /old session.*live/i.test(text)));
  assert.equal(f.worker.messages.length, 0);
});

test('replacement refuses unknown ownership and a busy session mutex without removing either artifact', { timeout: 20000 }, async t => {
  for (const fault of ['missing-registration', 'busy-mutex']) {
    await t.test(fault, async t => {
      const { f, oldId, oldWorker } = await replacementFixture(t);
      const lock = join(f.root, 'ownership', `fence-${createHash('sha256').update(oldWorker.file).digest('hex')}.lock`);
      if (fault === 'missing-registration') await rm(join(f.root, `ready-${oldId}.json`));
      else await mkdir(lock);
      await f.workerStart();
      const state = await f.state();
      assert.ok(state.workers[oldId]);
      assert.equal(state.workers[f.workerId()], undefined);
      assert.deepEqual(state.retiredWorkers, {});
      assert.equal(f.worker.confirmations.length, 1);
      assert.equal((await f.observation()).hold, true);
      if (fault === 'busy-mutex') await assert.rejects(mkdir(lock), { code: 'EEXIST' });
    });
  }
});

test('replacement consent must match the durable opt-in and cannot be forged in an IPC request', { timeout: 10000 }, async t => {
  const { f, oldId } = await replacementFixture(t);
  f.worker.confirm(title => !title.startsWith('Retire'));
  await f.workerStart();
  const record = await readJson(join(f.root, `worker-${f.workerId()}.json`));
  const result = await sendAction(f.root, { type: 'worker-start', workerId: record.workerId,
    ...record.start, replaceWorkerId: oldId }, 'supervisor');
  assert.equal(result.accepted, false);
  assert.ok((await f.state()).workers[oldId]);
  assert.equal((await f.state()).workers[record.workerId], undefined);
});

test('Escape during replacement confirmation cannot activate the new worker or retire the old one', { timeout: 10000 }, async t => {
  const { f, oldId } = await replacementFixture(t);
  f.worker.confirm(title => {
    if (title.startsWith('Retire')) f.worker.raw('\u001b');
    return true;
  });
  await f.workerStart();
  const state = await f.state();
  assert.ok(state.workers[oldId]);
  assert.equal(state.workers[f.workerId()], undefined);
  assert.deepEqual(state.retiredWorkers, {});
  assert.equal((await f.observation()).hold, true);
  assert.equal(f.worker.messages.length, 0);
});
