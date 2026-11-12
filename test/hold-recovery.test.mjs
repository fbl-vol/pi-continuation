import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bindContinuation } from '../src/ordinary.mjs';
import { readJson, atomicJson } from '../src/store.mjs';

// Actual ordinary handlers and durable observations; only native UI/session are fake.
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'held-report-'));
  const entries = [], input = new Set(), handlers = new Map(), commands = new Map(), confirmations = [], notices = [];
  let leaf = 'initial', confirm = async () => true;
  const ctx = { mode: 'tui', cwd: root, isIdle: () => true, sessionManager: {
    getSessionId: () => 'native', getSessionFile: () => join(root, 'native.jsonl'),
    getLeafId: () => leaf, getBranch: () => entries,
  }, ui: { confirm: async (...args) => { confirmations.push(args); return confirm(); },
    select: async () => undefined, input: async () => undefined, editor: async () => undefined,
    custom: async () => undefined, notify: message => notices.push(message),
    onTerminalInput: fn => { input.add(fn); return () => input.delete(fn); } } };
  const pi = { on: (name, fn) => handlers.set(name, [...(handlers.get(name) ?? []), fn]),
    registerCommand: (name, command) => commands.set(name, command.handler), registerTool: () => {},
    appendEntry: (customType, data) => entries.push({ type: 'custom', customType, data }),
    sendMessage: () => assert.fail('Clear cannot send a continuation'),
    sendUserMessage: () => assert.fail('Clear cannot send a new task') };
  const emit = async (name, event = {}) => { for (const fn of handlers.get(name) ?? []) await fn(event, ctx); };
  const previous = process.env.HERDR_ENV;
  process.env.HERDR_ENV = '1';
  bindContinuation(pi, { root, socketPath: join(root, 'fake.sock'), paneId: 'fake:p1' });
  t.after(async () => {
    await emit('session_shutdown');
    if (previous === undefined) delete process.env.HERDR_ENV; else process.env.HERDR_ENV = previous;
    await rm(root, { recursive: true, force: true });
  });
  await writeFile(join(root, 'native.jsonl'), '{}\n');
  const checkpoint = join(root, 'checkpoint.md');
  await writeFile(checkpoint, 'Remaining already-approved work.');
  await emit('session_start');
  await commands.get('continuation-worker')(checkpoint, ctx);
  const [file] = (await readdir(root)).filter(name => name.startsWith('observation-'));
  const rawInput = () => { for (const fn of input) fn({ data: '/continuation-worker-clear-hold\r' }); };
  const assistant = (text, stopReason = 'stop') => {
    leaf = `reply-${entries.length}`;
    entries.push({ id: leaf, type: 'message', message: { role: 'assistant', stopReason,
      content: [{ type: 'text', text }] } });
  };
  return { ctx, entries, emit, assistant, rawInput, confirmations, notices,
    removeObservation: () => rm(join(root, file)),
    saveSupervisor: value => atomicJson(join(root, 'supervisor.json'), value),
    supervisor: () => readJson(join(root, 'supervisor.json')),
    saved: () => readJson(join(root, file)), setConfirm: fn => { confirm = fn; },
    clear: async () => { rawInput(); await commands.get('continuation-worker-clear-hold')('', ctx); },
    freshHeld: async (text = 'Remaining approved work.', reason = 'stop', aborted = false) => {
      rawInput();
      await emit('input', { source: 'interactive', text: 'Continue approved work' });
      await emit('agent_start');
      assistant(text, reason);
      await emit('agent_settled', { aborted });
    } };
}

test('P3/P4/P7 Clear reassesses only the unchanged fresh held report, with the same nonce', async t => {
  const s = await fixture(t);
  await s.freshHeld();
  const held = await s.saved();
  assert.equal(held.outcome, 'approval');
  assert.equal(held.hold, true);
  await s.clear();
  const cleared = await s.saved();
  assert.equal(cleared.hold, false);
  assert.equal(cleared.outcome, 'completed');
  assert.equal(cleared.stop, held.stop);
  assert.equal(cleared.finalReply, held.finalReply);
  assert.deepEqual(cleared.session, held.session);
  assert.equal(cleared.version, held.version + 1);
  assert.match(s.confirmations.at(-1)[1], /current unchanged report/i);
  assert.match(s.confirmations.at(-1)[1], /not.*approv/i);
});

for (const kind of ['no report', 'aborted', 'error', 'stale leaf', 'stale session',
  'stale generation', 'changed reply', 'later user', 'old eligible']) {
  test(`P3/P7 Clear does not rearm ${kind}`, async t => {
    const s = await fixture(t);
    if (kind === 'old eligible') {
      await s.emit('agent_start');
      s.assistant('Previously eligible report.');
      await s.emit('agent_settled');
      assert.equal((await s.saved()).outcome, 'completed');
      s.rawInput(); // Invalidate an eligible stop; this is not a fresh held report.
    } else {
      await s.freshHeld(kind === 'no report' ? '' : 'Remaining work.',
        kind === 'error' ? 'error' : 'stop', kind === 'aborted');
      if (kind === 'stale leaf') s.ctx.sessionManager.getLeafId = () => 'different-leaf';
      if (kind === 'stale session') s.ctx.sessionManager.getSessionFile = () => '/different/session.jsonl';
      if (kind === 'stale generation') await s.emit('input', { source: 'interactive', text: 'New input' });
      if (kind === 'changed reply') s.entries.at(-1).message.content[0].text = 'Changed report';
      if (kind === 'later user') s.entries.push({ type: 'message', message: { role: 'user', content: 'Unfinished' } });
    }
    await s.clear();
    const cleared = await s.saved();
    assert.equal(cleared.hold, false);
    assert.equal(cleared.outcome, 'unknown');
    assert.equal(cleared.stop, null);
  });
}

for (const change of ['identity', 'generation', 'working', 'declined']) {
  test(`P3/P4 Clear retains the hold if ${change} changes during confirmation`, async t => {
    const s = await fixture(t);
    await s.freshHeld();
    s.setConfirm(async () => {
      if (change === 'identity') s.ctx.sessionManager.getSessionId = () => 'another-session';
      if (change === 'generation') await s.emit('input', { source: 'interactive', text: 'Later input' });
      if (change === 'working') s.ctx.isIdle = () => false;
      return change !== 'declined';
    });
    await s.clear();
    assert.equal((await s.saved()).hold, true);
  });
}

test('P3 Clear read failure retains hold and reports diagnostics instead of throwing', async t => {
  const s = await fixture(t);
  await s.freshHeld();
  await s.removeObservation();
  const confirmations = s.confirmations.length;
  await s.clear();
  assert.equal(s.confirmations.length, confirmations);
  assert.match(s.notices.at(-1), /read held report failed \(ENOENT\)/);
  await s.emit('agent_settled');
  assert.equal((await s.saved()).hold, true);
});

test('P4/P7 Clear leaves scoped pauses, exhausted budgets and consumed/ambiguous history untouched', async t => {
  const s = await fixture(t);
  await s.freshHeld();
  const held = await s.saved();
  const state = { paused: true, routes: { route: { paused: true } },
    workers: { worker: { paused: true, route: 'route' } },
    budgets: { worker: { count: 2, hash: 'unchanged', checkpoint: 'Remaining approved work.' } },
    handled: { worker: held.stop }, resumed: { worker: held.stop },
    inflight: { worker: { id: 'ambiguous-intent', stop: held.stop } } };
  await s.saveSupervisor(state);
  await s.clear();
  assert.deepEqual(await s.supervisor(), state);
  assert.equal((await s.saved()).stop, held.stop); // No fresh key to evade those guards.
});
