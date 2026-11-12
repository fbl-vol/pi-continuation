import test from 'node:test';
import assert from 'node:assert/strict';
import { guardPromptUI } from '../src/prompt-guard.mjs';

const methods = ['select', 'confirm', 'input', 'editor', 'custom'];
const uiWith = implementation => Object.fromEntries(methods.map(name => [name, implementation]));

test('all shared UI calls hold synchronously before display and preserve arguments/results', async () => {
  let holds = 0;
  const ui = uiWith(function (...args) {
    assert.equal(this, ui);
    assert.ok(holds > 0);
    assert.equal(guard.blocked, true);
    return Promise.resolve(args);
  });
  const guard = guardPromptUI(ui, () => { holds++; });
  for (const name of methods) {
    assert.deepEqual(await ui[name]('title', 'value'), ['title', 'value']);
    assert.equal(guard.blocked, false);
  }
  assert.equal(holds, 5); // Closing a dialog never clears the caller's sticky hold.
  guard.dispose();
});

test('an external prompt entirely inside an owned confirmation cannot be hidden by coalesced lifecycle events', async () => {
  const own = Promise.withResolvers();
  let holds = 0;
  const ui = uiWith(async () => 'external result');
  ui.confirm = () => { guard.start(); return own.promise.finally(() => guard.end()); };
  const guard = guardPromptUI(ui, () => { holds++; });
  const confirmation = guard.confirm('own', 'message');
  assert.equal(holds, 0);
  assert.equal(guard.blocked, true);
  // Pi emits no additional outer start/end for this fully overlapping call.
  await ui.input('other approval');
  own.resolve(true);
  assert.equal(await confirmation, false);
  assert.equal(holds, 1);
  assert.equal(guard.blocked, false);
  guard.dispose();
});

test('uncontended own confirmation remains usable and concurrent own confirmation is refused', async () => {
  const own = Promise.withResolvers();
  const ui = uiWith(async () => undefined);
  ui.confirm = () => { guard.start(); return own.promise.finally(() => guard.end()); };
  const guard = guardPromptUI(ui, () => assert.fail('own prompt is not worker approval'));
  const confirmation = guard.confirm('own');
  assert.equal(await guard.confirm('second own'), false);
  own.resolve(true);
  assert.equal(await confirmation, true);
  guard.dispose();
});

test('untracked lifecycle prompts block confirmation and signal a sticky hold', async () => {
  let holds = 0;
  const guard = guardPromptUI(uiWith(async () => true), () => { holds++; });
  guard.start();
  assert.equal(await guard.confirm('own'), false);
  assert.equal(holds, 1);
  guard.end();
  assert.equal(holds, 1);
  assert.equal(await guard.confirm('own'), true);
  guard.dispose();
});

test('UI replacement and disposal cannot silently rearm the old guard or overwrite another extension', async () => {
  let holds = 0;
  const ui = uiWith(async () => true);
  const original = ui.input;
  const guard = guardPromptUI(ui, () => { holds++; });
  const cached = ui.input;
  const replacement = async () => false;
  ui.input = replacement;
  assert.equal(guard.intact, false);
  assert.equal(guard.blocked, true);
  assert.equal(await guard.confirm('own'), false);
  guard.dispose();
  assert.equal(ui.input, replacement);
  assert.equal(await cached('after shutdown'), true);
  assert.equal(holds, 1); // Observed integrity loss is sticky; disposal emits no additional hold.
  assert.notEqual(ui.input, original);
});

test('observed loss of a prompt wrapper cannot be erased by putting the wrapper back', async () => {
  let holds = 0;
  const ui = uiWith(async () => true);
  const guard = guardPromptUI(ui, () => { holds++; });
  const wrapped = ui.input;
  ui.input = async () => undefined;
  assert.equal(guard.blocked, true);
  ui.input = wrapped;
  assert.equal(guard.blocked, true);
  assert.equal(guard.intact, false);
  assert.equal(guard.revision, 1);
  assert.equal(holds, 1);
  assert.equal(await guard.confirm('own'), false);
  assert.equal(holds, 1);
  guard.dispose();
});

test('synchronous failures and rejected UI promises retain holds but release active prompt counts', async () => {
  let holds = 0;
  const ui = uiWith(() => { throw new Error('display failed'); });
  ui.input = async () => { throw new Error('input failed'); };
  const guard = guardPromptUI(ui, () => { holds++; });
  assert.throws(() => ui.confirm('external'), /display failed/);
  assert.equal(guard.blocked, false);
  await assert.rejects(ui.input('external'), /input failed/);
  assert.equal(guard.blocked, false);
  assert.equal(holds, 2);
  guard.dispose();
});

test('partial installation on an unsupported UI restores methods already wrapped', () => {
  const ui = uiWith(async () => true);
  const select = ui.select;
  Object.defineProperty(ui, 'confirm', { value: ui.confirm, writable: false });
  assert.throws(() => guardPromptUI(ui, () => {}), TypeError);
  assert.equal(ui.select, select);
});
