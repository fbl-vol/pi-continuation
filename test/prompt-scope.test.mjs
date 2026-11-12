import test from 'node:test';
import assert from 'node:assert/strict';
import { createPromptScope } from '../src/prompt-scope.mjs';
import { guardPromptUI } from '../src/prompt-guard.mjs';

const methods = ['select', 'confirm', 'input', 'editor', 'custom'];
const uiWith = implementation => Object.fromEntries(methods.map(name => [name, implementation]));
const shortcut = (scope, handler) => scope.resources({ extensions: [{
  shortcuts: new Map([['ctrl+alt+u', { handler }]]),
}] }).extensions[0].shortcuts.get('ctrl+alt+u').handler;

test('shortcut prompts signal the shared guard synchronously and revoke an overlapping owned confirmation', async () => {
  const scope = createPromptScope();
  const own = Promise.withResolvers();
  let holds = 0;
  const shared = uiWith(async () => undefined);
  shared.confirm = () => own.promise;
  const guard = guardPromptUI(shared, () => { holds++; }, scope);
  const approval = guard.confirm('own');
  assert.equal(scope.snapshot().revision, 0, 'owned confirmation is not external activity');
  const foreign = uiWith(function (...args) {
    assert.equal(this, foreign);
    assert.equal(holds > 0, true);
    assert.equal(scope.active, true);
    return args;
  });
  const run = shortcut(scope, async ctx => {
    for (const name of methods) assert.deepEqual(await ctx.ui[name]('other', name), ['other', name]);
  });
  await run({ ui: foreign });
  own.resolve(true);
  assert.equal(await approval, false);
  assert.equal(holds, methods.length);
  assert.equal(scope.active, false);
  assert.equal(scope.snapshot().revision, methods.length);
  guard.dispose();
});

test('a pending foreign factory prevents new owned confirmation and failure releases activity without clearing the hold', async () => {
  const scope = createPromptScope();
  const pending = Promise.withResolvers();
  let holds = 0;
  const guard = guardPromptUI(uiWith(async () => true), () => { holds++; }, scope);
  const run = shortcut(scope, ctx => ctx.ui.custom('factory'));
  const result = run({ ui: uiWith(() => pending.promise) });
  assert.equal(await guard.confirm('own'), false);
  pending.reject(new Error('factory failed'));
  await assert.rejects(result, /factory failed/);
  assert.equal(scope.active, false);
  assert.equal(holds, 1);
  assert.equal(await guard.confirm('fresh own'), true);
  guard.dispose();
});

test('cached shortcut contexts keep reporting across guard replacement, not to the disposed owner', async () => {
  const scope = createPromptScope();
  let ctx;
  const run = shortcut(scope, value => { ctx = value; });
  await run({ ui: uiWith(() => { throw new Error('sync UI failure'); }) });
  let oldHolds = 0, newHolds = 0;
  const first = guardPromptUI(uiWith(async () => true), () => { oldHolds++; }, scope);
  first.dispose();
  const next = guardPromptUI(uiWith(async () => true), () => { newHolds++; }, scope);
  assert.throws(() => ctx.ui.input('cached'), /sync UI failure/);
  assert.equal(scope.active, false);
  assert.equal(oldHolds, 0);
  assert.equal(newHolds, 1);
  assert.equal(scope.snapshot().revision, 1);
  next.dispose();
});

test('shared UI remains observed after guard disposal and reaches only the replacement owner', async () => {
  const scope = createPromptScope();
  let oldHolds = 0, newHolds = 0;
  const shared = uiWith(async () => undefined);
  const first = guardPromptUI(shared, () => { oldHolds++; }, scope);
  first.dispose();
  const next = guardPromptUI(uiWith(async () => true), () => { newHolds++; }, scope);
  await shared.input('cached shared approval');
  assert.equal(oldHolds, 0);
  assert.equal(newHolds, 1);
  assert.equal(scope.snapshot().revision, 1);
  assert.equal(scope.active, false);
  next.dispose();
});

test('owned confirmation bypasses only its invocation, not a synchronous nested shared prompt', async () => {
  const scope = createPromptScope();
  let holds = 0, overlap = true, nested;
  const shared = uiWith(async () => undefined);
  shared.confirm = () => {
    if (overlap) nested = shared.input('nested foreign approval');
    return true;
  };
  const guard = guardPromptUI(shared, () => { holds++; }, scope);
  assert.equal(await guard.confirm('own'), false);
  assert.equal(holds, 1);
  assert.equal(scope.snapshot().revision, 1);
  await nested;
  overlap = false;
  assert.equal(await guard.confirm('fresh owned'), true);
  assert.equal(holds, 1);
  guard.dispose();
});

test('failed scope instrumentation restores partially wrapped UI without publishing a context', () => {
  const scope = createPromptScope();
  const ui = uiWith(async () => undefined);
  const originals = { ...ui };
  Object.defineProperty(ui, 'custom', { writable: false, configurable: true });
  assert.throws(() => scope.observeUI(ui), TypeError);
  for (const name of methods) assert.equal(ui[name], originals[name]);
  Object.defineProperty(ui, 'custom', { writable: true });
  assert.equal(scope.observeUI(ui), ui);
  assert.equal(scope.snapshot().revision, 0);
});

test('native model auth revokes overlapping consent while preserving its receiver, arguments and opaque result', async () => {
  const scope = createPromptScope();
  const own = Promise.withResolvers(), auth = Promise.withResolvers();
  let holds = 0;
  const guard = guardPromptUI(uiWith(() => own.promise), () => { holds++; }, scope);
  const args = ['synthetic', 'oauth', {}, {}], credential = {};
  const models = { login(...received) {
    assert.equal(this, models);
    assert.equal(received.length, args.length);
    for (const [index, value] of args.entries()) assert.equal(received[index], value);
    assert.equal(holds, 1, 'hold is signalled before entering native auth');
    return auth.promise;
  } };
  assert.equal(scope.observeModelAuth(models), models);
  const wrapped = models.login;
  scope.observeModelAuth(models);
  assert.equal(models.login, wrapped, 'shared native models are not wrapped twice');
  const consent = guard.confirm('own');
  const pending = models.login(...args);
  assert.equal(scope.active, true);
  assert.equal(await guard.confirm('another own'), false);
  auth.resolve(credential);
  assert.equal(await pending, credential);
  assert.equal(scope.active, false);
  own.resolve(true);
  assert.equal(await consent, false, 'a fully overlapped auth flow also revokes consent');
  assert.equal(scope.snapshot().revision, 1);
  assert.equal(holds, 1);
  guard.dispose();
});

test('cached native auth reaches a replacement guard and failures release only the active lease', async () => {
  const scope = createPromptScope();
  let syncFailure = true, oldHolds = 0, newHolds = 0;
  const models = { login() {
    if (syncFailure) throw new Error('synthetic sync auth failure');
    return Promise.reject(new Error('synthetic async auth failure'));
  } };
  scope.observeModelAuth(models);
  const first = guardPromptUI(uiWith(async () => true), () => { oldHolds++; }, scope);
  first.dispose();
  const next = guardPromptUI(uiWith(async () => true), () => { newHolds++; }, scope);
  assert.throws(() => models.login(), /sync auth failure/);
  assert.equal(scope.active, false);
  syncFailure = false;
  await assert.rejects(models.login(), /async auth failure/);
  assert.equal(scope.active, false);
  assert.equal(oldHolds, 0);
  assert.equal(newHolds, 2, 'auth failure does not erase previously signalled holds');
  next.dispose();
});

test('detected native auth hook loss invalidates the host scope even after restoration or guard replacement', async () => {
  const scope = createPromptScope();
  const models = { login: async () => undefined };
  scope.observeModelAuth(models);
  const wrapped = models.login;
  let holds = 0;
  const first = guardPromptUI(uiWith(async () => true), () => { holds++; }, scope);
  models.login = async () => undefined;
  assert.equal(first.blocked, true);
  assert.equal(holds, 1);
  models.login = wrapped;
  assert.equal(first.blocked, true);
  assert.equal(holds, 1);
  first.dispose();
  const next = guardPromptUI(uiWith(async () => true), () => { holds++; }, scope);
  assert.equal(await next.confirm('fresh own'), false);
  assert.equal(scope.active, true);
  assert.equal(scope.snapshot().revision, 1);
  next.dispose();
});

test('unsupported or immutable native auth surfaces are refused rather than silently omitted', () => {
  const scope = createPromptScope();
  assert.throws(() => scope.observeModelAuth({}), /Unsupported model auth surface/);
  const models = Object.freeze({ login: async () => undefined });
  assert.throws(() => scope.observeModelAuth(models), TypeError);
  assert.equal(scope.active, false);
  assert.equal(scope.snapshot().revision, 0);
});

test('resource wrapping preserves metadata, handler return values and non-prompt context access', async () => {
  const scope = createPromptScope();
  const marker = {};
  const originalUI = { ...uiWith(async () => undefined), notify: () => marker };
  const ctx = { ui: originalUI, mode: 'tui', get cwd() { return '/synthetic'; } };
  const base = { errors: [], runtime: marker, extensions: [{ path: '/synthetic/extension',
    commands: marker, shortcuts: new Map([['ctrl+alt+u', { description: 'metadata',
      handler(value) { assert.equal(value.mode, 'tui'); assert.equal(value.cwd, '/synthetic');
        assert.equal(value.ui.notify(), marker); return marker; } }]]) }] };
  const wrapped = scope.resources(base);
  assert.equal(wrapped.runtime, marker);
  assert.equal(wrapped.errors, base.errors);
  assert.equal(wrapped.extensions[0].commands, marker);
  const entry = wrapped.extensions[0].shortcuts.get('ctrl+alt+u');
  assert.equal(entry.description, 'metadata');
  assert.equal(entry.handler(ctx), marker);
  assert.equal(scope.snapshot().revision, 0);
  assert.equal(base.extensions[0].shortcuts.get('ctrl+alt+u').handler(ctx), marker);
});
