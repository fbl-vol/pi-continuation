import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bindObservation as bindWorkerObservation } from '../src/observation.mjs';
import { MAX_FINAL_REPLY_BYTES } from '../src/contracts.mjs';
import { readWorkerRegistration } from '../src/bindings.mjs';

const bindObservation = (pi, options) => bindWorkerObservation(pi,
  { ...options, launchGuard: () => true });

function fakePi(sessionId, sessionFile) {
  const handlers = new Map();
  const entries = [];
  const sessionManager = {
    getSessionId: () => sessionId, getSessionFile: () => sessionFile,
    getLeafId: () => 'leaf', getBranch: () => entries,
  };
  const notices = [];
  const terminalInput = new Set();
  const ctx = { mode: 'tui', cwd: '/project', sessionManager, isIdle: () => true,
    ui: { confirm: async () => true, notify: (...args) => notices.push(args),
      onTerminalInput: handler => { terminalInput.add(handler); return () => terminalInput.delete(handler); } } };
  const pi = { on: (name, fn) => handlers.set(name, fn),
    registerCommand: (name, definition) => {
      if (name === 'continuation-worker') pi.command = definition.handler;
      if (name === 'continuation-worker-clear-hold') pi.clearHold = definition.handler;
    },
    appendEntry: (customType, data) => entries.push({ type: 'custom', customType, data }) };
  return { pi, ctx, notices, entries, terminalInput,
    emit: (event, data = {}) => handlers.get(event)?.(data, ctx) };
}

test('a failed session entry rolls back provisional registration instead of reporting success', async () => {
  const root = await mkdtemp(join(tmpdir(), 'continuation-'));
  const checkpoint = join(root, 'checkpoint.md');
  await writeFile(checkpoint, 'unfinished');
  const s = fakePi('session', '/sessions/session.jsonl');
  const prior = process.env.HERDR_ENV;
  process.env.HERDR_ENV = '1';
  try {
    s.pi.appendEntry = () => { throw Object.assign(new Error('test append failure'), { code: 'EIO' }); };
    const observer = bindObservation(s.pi, { root, socketPath: 'socket', paneId: 'w1:p1' });
    await s.pi.command(checkpoint, s.ctx);
    assert.equal(observer.registered, false);
    assert.equal(s.notices.length, 1);
    assert.equal(s.notices[0][1], 'error');
    assert.match(s.notices[0][0], /register worker failed/);
    assert.doesNotMatch(s.notices[0][0], /registered paused/);
    assert.deepEqual((await readdir(root)).filter(name => /^(worker|observation)-/.test(name)), []);
    assert.equal(s.notices[0][0].includes(root), false);
  } finally {
    await s.emit('session_shutdown');
    if (prior === undefined) delete process.env.HERDR_ENV;
    else process.env.HERDR_ENV = prior;
    await rm(root, { recursive: true, force: true });
  }
});

test('registration starts paused and a fork cannot inherit it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'continuation-'));
  const checkpoint = join(root, 'checkpoint.md');
  await writeFile(checkpoint, 'unfinished');
  const original = fakePi('original', '/sessions/original.jsonl');
  const fork = fakePi('fork', '/sessions/fork.jsonl');
  const prior = process.env.HERDR_ENV;
  process.env.HERDR_ENV = '1';
  try {
    const observer = bindObservation(original.pi, { root, socketPath: 'socket', paneId: 'w1:p1' });
    original.ctx.ui.confirm = async () => { await original.emit('ui_prompt_start'); return true; };
    await original.emit('session_start');
    await original.pi.command(checkpoint, original.ctx);
    const workerId = original.entries[0].data.workerId;
    const registered = JSON.parse(await readFile(join(root, `worker-${workerId}.json`)));
    assert.equal(registered.paused, true);
    assert.equal(observer.hold, false);
    assert.equal(registered.sessionId, 'original');

    fork.entries.push(original.entries[0]);
    bindObservation(fork.pi, { root, socketPath: 'socket', paneId: 'w1:p1' });
    await fork.emit('session_start', { reason: 'fork' });
    await fork.emit('agent_settled', { aborted: false });
    const observed = JSON.parse(await readFile(join(root, `observation-${workerId}.json`)));
    assert.equal(observed.session.id, 'original');
    assert.equal(observed.outcome, 'unknown');
  } finally {
    await original.emit('session_shutdown');
    if (prior === undefined) delete process.env.HERDR_ENV;
    else process.env.HERDR_ENV = prior;
    await rm(root, { recursive: true, force: true });
  }
});

test('plain registration persists an unheld observation across a same-session reload', async () => {
  const root = await mkdtemp(join(tmpdir(), 'continuation-'));
  const checkpoint = join(root, 'checkpoint.md');
  await writeFile(checkpoint, 'unfinished');
  const first = fakePi('same', '/sessions/same.jsonl');
  const next = fakePi('same', '/sessions/same.jsonl');
  const prior = process.env.HERDR_ENV;
  process.env.HERDR_ENV = '1';
  try {
    bindObservation(first.pi, { root, socketPath: 'socket', paneId: 'w1:p1' });
    await first.emit('session_start');
    await first.pi.command(checkpoint, first.ctx);
    const id = first.entries.at(-1).data.workerId;
    assert.equal((await readWorkerRegistration(root, id)).checkpoint, checkpoint);
    const saved = JSON.parse(await readFile(join(root, `observation-${id}.json`)));
    assert.equal(saved.hold, false);
    assert.equal(saved.stop, null);
    await first.emit('session_shutdown');
    next.entries.push(first.entries.at(-1));
    const observer = bindObservation(next.pi, { root, socketPath: 'socket', paneId: 'w1:p1' });
    await next.emit('session_start');
    assert.equal(observer.registered, true);
    assert.equal(observer.hold, false);
  } finally {
    await first.emit('session_shutdown');
    await next.emit('session_shutdown');
    if (prior === undefined) delete process.env.HERDR_ENV;
    else process.env.HERDR_ENV = prior;
    await rm(root, { recursive: true, force: true });
  }
});

test('same-session reload restores sticky abort hold and closes old receiver', async () => {
  const root = await mkdtemp(join(tmpdir(), 'continuation-'));
  const checkpoint = join(root, 'checkpoint.md');
  await writeFile(checkpoint, 'unfinished');
  const first = fakePi('same', '/sessions/same.jsonl');
  const next = fakePi('same', '/sessions/same.jsonl');
  const prior = process.env.HERDR_ENV;
  process.env.HERDR_ENV = '1';
  try {
    bindObservation(first.pi, { root, socketPath: 'socket', paneId: 'w1:p1' });
    await first.emit('session_start');
    await first.pi.command(checkpoint, first.ctx);
    await first.emit('agent_settled', { aborted: true });
    await first.emit('session_shutdown');
    next.entries.push(...first.entries);
    const receiver = bindObservation(next.pi, { root, socketPath: 'socket', paneId: 'w1:p1' });
    await next.emit('session_start', { reason: 'reload' });
    assert.equal(receiver.registered, true);
    assert.equal(receiver.hold, true);
  } finally {
    await next.emit('session_shutdown');
    if (prior === undefined) delete process.env.HERDR_ENV;
    else process.env.HERDR_ENV = prior;
    await rm(root, { recursive: true, force: true });
  }
});

test('sticky hold survives a subsequent working observation and restart until explicitly cleared', async () => {
  const root = await mkdtemp(join(tmpdir(), 'continuation-'));
  const checkpoint = join(root, 'checkpoint.md');
  await writeFile(checkpoint, 'unfinished');
  const first = fakePi('same', '/sessions/same.jsonl');
  const next = fakePi('same', '/sessions/same.jsonl');
  const prior = process.env.HERDR_ENV;
  process.env.HERDR_ENV = '1';
  try {
    bindObservation(first.pi, { root, socketPath: 'socket', paneId: 'w1:p1' });
    await first.emit('session_start');
    await first.pi.command(checkpoint, first.ctx);
    await first.emit('agent_settled', { aborted: true });
    await first.emit('agent_start');
    await first.emit('session_shutdown');
    next.entries.push(...first.entries);
    const observer = bindObservation(next.pi, { root, socketPath: 'socket', paneId: 'w1:p1' });
    await next.emit('session_start', { reason: 'startup' });
    assert.equal(observer.hold, true);
    await next.emit('agent_start');
    next.entries.push({ type: 'message', id: 'new', message: { role: 'assistant', stopReason: 'stop' } });
    await next.emit('agent_settled', { aborted: false });
    const id = first.entries[0].data.workerId;
    const observation = () => readFile(join(root, `observation-${id}.json`), 'utf8').then(JSON.parse);
    assert.equal((await observation()).outcome, 'approval');
    await next.pi.clearHold('', next.ctx);
    assert.equal(observer.hold, false);
    assert.equal((await observation()).stop, null);
    assert.equal((await observation()).hold, false);
  } finally {
    await next.emit('session_shutdown');
    if (prior === undefined) delete process.env.HERDR_ENV;
    else process.env.HERDR_ENV = prior;
    await rm(root, { recursive: true, force: true });
  }
});

test('registration refuses a worker launched after another extension', async () => {
  const root = await mkdtemp(join(tmpdir(), 'continuation-'));
  const checkpoint = join(root, 'checkpoint.md');
  await writeFile(checkpoint, 'unfinished');
  const worker = fakePi('native', '/sessions/native.jsonl');
  const prior = process.env.HERDR_ENV;
  process.env.HERDR_ENV = '1';
  try {
    bindWorkerObservation(worker.pi, { root, socketPath: 'socket', paneId: 'w1:p1',
      launchGuard: () => false });
    await worker.emit('session_start');
    await worker.pi.command(checkpoint, worker.ctx);
    assert.equal(worker.entries.length, 0);
    assert.match(worker.notices[0][0], /first option/);
    assert.equal(worker.terminalInput.size, 0);
  } finally {
    await worker.emit('session_shutdown');
    if (prior === undefined) delete process.env.HERDR_ENV;
    else process.env.HERDR_ENV = prior;
    await rm(root, { recursive: true, force: true });
  }
});

test('a registered worker restart without the first-extension guard stays inert', async () => {
  const root = await mkdtemp(join(tmpdir(), 'continuation-'));
  const checkpoint = join(root, 'checkpoint.md');
  await writeFile(checkpoint, 'unfinished');
  const first = fakePi('native', '/sessions/native.jsonl');
  const restarted = fakePi('native', '/sessions/native.jsonl');
  const prior = process.env.HERDR_ENV;
  process.env.HERDR_ENV = '1';
  try {
    bindObservation(first.pi, { root, socketPath: 'socket', paneId: 'w1:p1' });
    await first.emit('session_start');
    await first.pi.command(checkpoint, first.ctx);
    const workerId = first.entries.at(-1).data.workerId;
    await first.emit('session_shutdown');

    restarted.entries.push(...first.entries);
    const observer = bindWorkerObservation(restarted.pi, { root, socketPath: 'socket',
      paneId: 'w1:p1', launchGuard: () => false });
    await restarted.emit('session_start');
    await restarted.emit('agent_settled', { aborted: false });
    assert.equal(observer.registered, false);
    assert.equal(restarted.terminalInput.size, 0);
    assert.match(restarted.notices[0][0], /worker disabled.*first option/);
    const saved = JSON.parse(await readFile(join(root, `observation-${workerId}.json`)));
    assert.equal(saved.outcome, 'unknown');
  } finally {
    await restarted.emit('session_shutdown');
    if (prior === undefined) delete process.env.HERDR_ENV;
    else process.env.HERDR_ENV = prior;
    await rm(root, { recursive: true, force: true });
  }
});

test('raw user input holds a worker before Pi handles a built-in dialog', async () => {
  const root = await mkdtemp(join(tmpdir(), 'continuation-'));
  const checkpoint = join(root, 'checkpoint.md');
  await writeFile(checkpoint, 'unfinished');
  const worker = fakePi('native', '/sessions/native.jsonl');
  const prior = process.env.HERDR_ENV;
  process.env.HERDR_ENV = '1';
  try {
    const observer = bindObservation(worker.pi, { root, socketPath: 'socket', paneId: 'w1:p1' });
    await worker.emit('session_start');
    await worker.pi.command(checkpoint, worker.ctx);
    const id = worker.entries.at(-1).data.workerId;
    assert.equal(worker.terminalInput.size, 1);

    for (const input of worker.terminalInput) input('/model');
    assert.equal(observer.hold, true);
    worker.entries.push({ type: 'message', id: 'finished',
      message: { role: 'assistant', stopReason: 'stop' } });
    await worker.emit('agent_settled', { aborted: false });
    const observed = JSON.parse(await readFile(join(root, `observation-${id}.json`)));
    assert.equal(observed.outcome, 'approval');
    assert.equal(observed.hold, true);
    assert.notEqual(observed.stop, null);
  } finally {
    await worker.emit('session_shutdown');
    if (prior === undefined) delete process.env.HERDR_ENV;
    else process.env.HERDR_ENV = prior;
    await rm(root, { recursive: true, force: true });
  }
  assert.equal(worker.terminalInput.size, 0);
});

test('an explicit first turn is published and sent only after the provisional receiver is ready', async () => {
  const root = await mkdtemp(join(tmpdir(), 'continuation-'));
  const checkpoint = join(root, 'checkpoint -- with spaces.md');
  await writeFile(join(root, 'checkpoint'), 'Unrelated task');
  await writeFile(checkpoint, 'Approved task');
  const worker = fakePi('native', '/sessions/native.jsonl');
  const messages = [];
  worker.pi.sendUserMessage = text => messages.push(text);
  const prior = process.env.HERDR_ENV;
  process.env.HERDR_ENV = '1';
  try {
    const observer = bindObservation(worker.pi, { root, socketPath: 'socket', paneId: 'w1:p1' });
    await worker.emit('session_start');
    await worker.pi.command(`--start ${JSON.stringify({ checkpoint, message: 'Begin approved task.' })}`,
      worker.ctx);
    const id = worker.entries.at(-1).data.workerId;
    assert.equal(observer.registered, true);
    assert.equal(JSON.parse(await readFile(join(root, `worker-${id}.json`))).checkpoint, checkpoint);
    assert.equal(JSON.parse(await readFile(join(root, `ready-${id}.json`))).sessionId, 'native');
    assert.deepEqual(messages, ['Begin approved task.']);
    await worker.emit('before_agent_start', { messageType: 'user', prompt: 'Begin approved task.' });
    await worker.emit('agent_start');
    worker.entries.push({ type: 'message', id: 'initial-answer', message: { role: 'assistant',
      stopReason: 'stop', content: [{ type: 'text', text: 'Progress made.' }] } });
    await worker.emit('agent_settled', { aborted: false });
    const saved = JSON.parse(await readFile(join(root, `observation-${id}.json`)));
    assert.equal(saved.outcome, 'completed');
    assert.equal(saved.hold, false);
    assert.equal(saved.finalReply, 'Progress made.');
  } finally {
    await worker.emit('session_shutdown');
    if (prior === undefined) delete process.env.HERDR_ENV;
    else process.env.HERDR_ENV = prior;
    await rm(root, { recursive: true, force: true });
  }
});

test('an initial message handled without a run is not restored as an eligible worker', async () => {
  const root = await mkdtemp(join(tmpdir(), 'continuation-'));
  const checkpoint = join(root, 'checkpoint.md');
  await writeFile(checkpoint, 'Approved task');
  const worker = fakePi('native', '/sessions/native.jsonl');
  worker.pi.sendUserMessage = () => {}; // Pi may handle extension input without starting a run.
  const prior = process.env.HERDR_ENV;
  process.env.HERDR_ENV = '1';
  try {
    bindObservation(worker.pi, { root, socketPath: 'socket', paneId: 'w1:p1' });
    await worker.emit('session_start');
    await worker.pi.command(`--start ${JSON.stringify({ checkpoint, message: 'Begin approved task.' })}`,
      worker.ctx);
    const id = worker.entries.at(-1).data.workerId;
    const before = JSON.parse(await readFile(join(root, `observation-${id}.json`)));
    assert.equal(before.bootstrapPending, true);
    assert.equal(before.hold, true);
    assert.equal(before.stop, null);
    await worker.emit('session_shutdown');

    const restarted = fakePi('native', '/sessions/native.jsonl');
    restarted.entries.push(worker.entries.at(-1));
    const observer = bindObservation(restarted.pi, { root, socketPath: 'socket', paneId: 'w1:p1' });
    await restarted.emit('session_start');
    assert.equal(observer.registered, true);
    assert.equal(observer.hold, true);
    await restarted.emit('session_shutdown');
  } finally {
    await worker.emit('session_shutdown');
    if (prior === undefined) delete process.env.HERDR_ENV;
    else process.env.HERDR_ENV = prior;
    await rm(root, { recursive: true, force: true });
  }
});

test('a prompt hold acquired during provisional setup aborts without sending or publishing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'continuation-'));
  const checkpoint = join(root, 'checkpoint.md');
  await writeFile(checkpoint, 'Approved task');
  const worker = fakePi('native', '/sessions/native.jsonl');
  const messages = [];
  worker.pi.sendUserMessage = text => messages.push(text);
  let leafReads = 0;
  worker.ctx.sessionManager.getLeafId = () => {
    if (++leafReads === 3) void worker.emit('ui_prompt_start');
    return 'leaf';
  };
  const prior = process.env.HERDR_ENV;
  process.env.HERDR_ENV = '1';
  try {
    const observer = bindObservation(worker.pi, { root, socketPath: 'socket', paneId: 'w1:p1' });
    await worker.emit('session_start');
    const start = `--start ${JSON.stringify({ checkpoint, message: 'Begin approved task.' })}`;
    await worker.pi.command(start, worker.ctx);
    assert.equal(observer.registered, false);
    assert.deepEqual(messages, []);
    assert.deepEqual(worker.entries, []);
    assert.deepEqual((await readdir(root)).filter(name => /^(worker|observation)-/.test(name)), []);
    worker.ctx.sessionManager.getLeafId = () => 'leaf';
    await worker.pi.command(start, worker.ctx);
    assert.equal(observer.registered, true);
    assert.deepEqual(messages, ['Begin approved task.']);
  } finally {
    await worker.emit('session_shutdown');
    if (prior === undefined) delete process.env.HERDR_ENV;
    else process.env.HERDR_ENV = prior;
    await rm(root, { recursive: true, force: true });
  }
});

test('a prompt starting synchronously during the session append cannot authorize initial delivery', async () => {
  const root = await mkdtemp(join(tmpdir(), 'continuation-'));
  const checkpoint = join(root, 'checkpoint.md');
  await writeFile(checkpoint, 'Approved task');
  const worker = fakePi('native', '/sessions/native.jsonl');
  const messages = [];
  worker.pi.sendUserMessage = text => messages.push(text);
  const prior = process.env.HERDR_ENV;
  process.env.HERDR_ENV = '1';
  try {
    const observer = bindObservation(worker.pi, { root, socketPath: 'socket', paneId: 'w1:p1' });
    await worker.emit('session_start');
    const append = worker.pi.appendEntry;
    worker.pi.appendEntry = (...args) => { append(...args); void worker.emit('ui_prompt_start'); };
    await worker.pi.command(`--start ${JSON.stringify({ checkpoint, message: 'Begin approved task.' })}`,
      worker.ctx);
    assert.equal(observer.registered, false);
    assert.deepEqual(messages, []);
    assert.deepEqual((await readdir(root)).filter(name => /^(worker|observation)-/.test(name)), []);
    // A stale session entry is inert without a matching record; a later valid
    // registration would append a new entry after the user inspects the prompt.
    assert.equal(worker.entries.length, 1);
    const id = worker.entries[0].data.workerId;
    // Simulate both unlink operations failing after the session entry append.
    // The missing commit marker must still prevent restore of the stale record.
    await writeFile(join(root, `worker-${id}.json`), JSON.stringify({ workerId: id,
      sessionId: 'native', sessionFile: '/sessions/native.jsonl', paneId: 'w1:p1',
      checkpoint, cwd: '/project', requiresReady: true }));
    await writeFile(join(root, `observation-${id}.json`), JSON.stringify({
      schemaVersion: 1, session: { id: 'native', file: '/sessions/native.jsonl' },
      outcome: 'unknown', stop: null, hold: false, version: 0 }));
    const resumed = fakePi('native', '/sessions/native.jsonl');
    resumed.entries.push(worker.entries[0]);
    const restored = bindObservation(resumed.pi, { root, socketPath: 'socket', paneId: 'w1:p1' });
    await resumed.emit('session_start');
    assert.equal(restored.registered, false);
    await assert.rejects(readWorkerRegistration(root, id), { code: 'ENOENT' });
    await resumed.emit('session_shutdown');
  } finally {
    await worker.emit('session_shutdown');
    if (prior === undefined) delete process.env.HERDR_ENV;
    else process.env.HERDR_ENV = prior;
    await rm(root, { recursive: true, force: true });
  }
});

test('a busy first-turn race cancels registration so the user can retry explicitly', async () => {
  const root = await mkdtemp(join(tmpdir(), 'continuation-'));
  const checkpoint = join(root, 'checkpoint.md');
  await writeFile(checkpoint, 'Approved task');
  const worker = fakePi('native', '/sessions/native.jsonl');
  const messages = [];
  worker.pi.sendUserMessage = text => messages.push(text);
  let idleCalls = 0;
  worker.ctx.isIdle = () => ++idleCalls !== 2;
  const prior = process.env.HERDR_ENV;
  process.env.HERDR_ENV = '1';
  try {
    const observer = bindObservation(worker.pi, { root, socketPath: 'socket', paneId: 'w1:p1' });
    await worker.emit('session_start');
    const start = `--start ${JSON.stringify({ checkpoint, message: 'Begin approved task.' })}`;
    await worker.pi.command(start, worker.ctx);
    assert.equal(observer.registered, false);
    assert.deepEqual(messages, []);
    assert.deepEqual(worker.entries, []);
    assert.deepEqual((await readdir(root)).filter(name => /^(worker|observation)-/.test(name)), []);
    await worker.pi.command(start, worker.ctx);
    assert.equal(observer.registered, true);
    assert.deepEqual(messages, ['Begin approved task.']);
  } finally {
    await worker.emit('session_shutdown');
    if (prior === undefined) delete process.env.HERDR_ENV;
    else process.env.HERDR_ENV = prior;
    await rm(root, { recursive: true, force: true });
  }
});

test('an exact final reply is captured; oversized replies hold instead of hiding a request', async () => {
  const root = await mkdtemp(join(tmpdir(), 'continuation-'));
  const checkpoint = join(root, 'checkpoint.md');
  await writeFile(checkpoint, 'Approved work remains');
  const worker = fakePi('native', '/sessions/native.jsonl');
  const prior = process.env.HERDR_ENV;
  process.env.HERDR_ENV = '1';
  try {
    const observer = bindObservation(worker.pi, { root, socketPath: 'socket', paneId: 'w1:p1' });
    await worker.emit('session_start');
    await worker.pi.command(checkpoint, worker.ctx);
    const id = worker.entries.at(-1).data.workerId;
    await worker.emit('agent_start');
    worker.entries.push({ type: 'message', id: 'new-answer', message: { role: 'assistant',
      stopReason: 'stop', content: [{ type: 'text', text: 'Progress made. Can I deploy?' }] } });
    await worker.emit('agent_settled', { aborted: false });
    const saved = () => readFile(join(root, `observation-${id}.json`), 'utf8').then(JSON.parse);
    assert.equal((await saved()).outcome, 'completed');
    assert.equal((await saved()).hold, false);
    assert.equal((await saved()).finalReply, 'Progress made. Can I deploy?');

    await worker.emit('agent_start');
    worker.entries.push({ type: 'message', id: 'oversized', message: { role: 'assistant',
      stopReason: 'stop', content: [{ type: 'text', text: 'é'.repeat(MAX_FINAL_REPLY_BYTES) }] } });
    await worker.emit('agent_settled', { aborted: false });
    assert.equal(observer.hold, true);
    assert.equal((await saved()).outcome, 'approval');
    assert.equal((await saved()).hold, true);
    assert.equal((await saved()).finalReply, undefined);

    await worker.pi.clearHold('', worker.ctx);
    assert.equal(observer.hold, false);
    await worker.emit('agent_start');
    worker.entries.push({ type: 'message', id: 'empty', message: { role: 'assistant',
      stopReason: 'stop', content: [] } });
    await worker.emit('agent_settled', { aborted: false });
    assert.equal((await saved()).outcome, 'approval');
    assert.equal((await saved()).hold, true);
    assert.equal((await saved()).finalReply, undefined);
  } finally {
    await worker.emit('session_shutdown');
    if (prior === undefined) delete process.env.HERDR_ENV;
    else process.env.HERDR_ENV = prior;
    await rm(root, { recursive: true, force: true });
  }
});

test('a provider failure without a new assistant message cannot reuse an old completed stop', async () => {
  const root = await mkdtemp(join(tmpdir(), 'continuation-'));
  const checkpoint = join(root, 'checkpoint.md');
  await writeFile(checkpoint, 'unfinished');
  const worker = fakePi('native', '/sessions/native.jsonl');
  worker.entries.push({ type: 'message', id: 'old-assistant',
    message: { role: 'assistant', stopReason: 'stop' } });
  const prior = process.env.HERDR_ENV;
  process.env.HERDR_ENV = '1';
  try {
    bindObservation(worker.pi, { root, socketPath: 'socket', paneId: 'w1:p1' });
    await worker.emit('session_start');
    await worker.pi.command(checkpoint, worker.ctx);
    const id = worker.entries.at(-1).data.workerId;
    await worker.emit('agent_start');
    await worker.emit('agent_settled', { aborted: false });
    const observed = JSON.parse(await readFile(join(root, `observation-${id}.json`)));
    assert.equal(observed.outcome, 'unknown');
    assert.equal(observed.finalReply, undefined);
  } finally {
    await worker.emit('session_shutdown');
    if (prior === undefined) delete process.env.HERDR_ENV;
    else process.env.HERDR_ENV = prior;
    await rm(root, { recursive: true, force: true });
  }
});

test('aborted and UI prompt stops are held and working invalidates previous stop', async () => {
  const root = await mkdtemp(join(tmpdir(), 'continuation-'));
  const checkpoint = join(root, 'checkpoint.md');
  await writeFile(checkpoint, 'unfinished');
  const worker = fakePi('native', '/sessions/native.jsonl');
  worker.entries.push({ type: 'message', id: 'assistant-1', message: { role: 'assistant', stopReason: 'stop' } });
  const prior = process.env.HERDR_ENV;
  process.env.HERDR_ENV = '1';
  try {
    bindObservation(worker.pi, { root, socketPath: 'socket', paneId: 'w1:p1' });
    await worker.emit('session_start');
    await worker.pi.command(checkpoint, worker.ctx);
    const id = worker.entries.at(-1).data.workerId;
    const observation = () => readFile(join(root, `observation-${id}.json`), 'utf8').then(JSON.parse);
    await worker.emit('agent_settled', { aborted: true });
    assert.equal((await observation()).outcome, 'aborted');
    await worker.emit('ui_prompt_start');
    await worker.emit('agent_settled', { aborted: false });
    assert.equal((await observation()).outcome, 'approval');
    await worker.emit('agent_start');
    // Flush the queued atomic write without depending on a timer.
    await worker.emit('agent_settled', { aborted: true });
    assert.equal((await observation()).outcome, 'aborted');
  } finally {
    await worker.emit('session_shutdown');
    if (prior === undefined) delete process.env.HERDR_ENV;
    else process.env.HERDR_ENV = prior;
    await rm(root, { recursive: true, force: true });
  }
});
