import test from 'node:test';
import assert from 'node:assert/strict';
import { createPromptScope } from '../src/prompt-scope.mjs';

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
class NativeEditor {
  onSubmit;
  #text = '';
  history = [];
  constructor(tui, theme, keys, options) { this.options = options; }
  setText(text) { this.#text = text; }
  getText() { return this.#text; }
  render() { return [this.#text]; }
}
function nativeUI(callback) {
  let factory, editor;
  const tui = {}, theme = {}, keys = {};
  const ui = {
    getEditorComponent() { return factory; },
    setEditorComponent(value) {
      factory = value;
      editor = value ? value(tui, theme, keys) : new NativeEditor(tui, theme, keys);
      editor.onSubmit = callback;
    },
  };
  return { ui, get editor() { return editor; } };
}

test('native diagnostic callback holds synchronously through completion without replacing editor identity or rendering', async () => {
  const scope = createPromptScope({ Editor: NativeEditor });
  const pending = deferred();
  const opaque = Object.freeze({ native: 'opaque result' });
  let receiver, received;
  const f = nativeUI(function (...args) {
    receiver = this; received = args;
    assert.equal(scope.active, true);
    return pending.promise;
  });
  const original = new NativeEditor();
  const factory = () => original;
  f.ui.setEditorComponent(factory);
  scope.installEditor(f.ui);
  assert.equal(f.ui.getEditorComponent(), factory);
  assert.equal(f.editor, original);
  f.editor.setText('preserve native private-field methods');
  assert.deepEqual(f.editor.render(), ['preserve native private-field methods']);

  const revision = scope.snapshot().revision;
  const argument = Object.freeze({ opaque: true });
  const operation = f.editor.onSubmit(' /bug fixture ', argument);
  assert.equal(receiver, original);
  assert.equal(received[1], argument);
  assert.equal(scope.active, true);
  assert.ok(scope.snapshot().revision > revision);
  pending.resolve(opaque);
  assert.equal(await operation, opaque);
  assert.equal(scope.active, false);
});

test('ordinary submissions retain their native return value and can start owned commands immediately', async () => {
  const scope = createPromptScope({ Editor: NativeEditor });
  const pending = deferred();
  const f = nativeUI(() => {
    assert.equal(scope.active, false, 'an enqueued extension command must not overlap a submit lease');
    return pending.promise;
  });
  scope.installEditor(f.ui);
  const before = scope.snapshot();
  assert.equal(f.editor.onSubmit('/continuation-worker /synthetic/checkpoint'), pending.promise);
  assert.deepEqual(scope.snapshot(), before);
  assert.equal(scope.active, false);
  pending.resolve();
});

test('cached editor API, repeated initialization and default reset preserve observation and native default history', async () => {
  const scope = createPromptScope({ Editor: NativeEditor });
  let pending = deferred();
  const f = nativeUI(() => pending.promise);
  scope.installEditor(f.ui);
  const first = f.editor;
  first.history.push('retained native history');
  assert.deepEqual(first.options, { embedWorkingStatus: true });
  assert.equal(f.ui.getEditorComponent(), undefined);
  scope.installEditor(f.ui);
  assert.equal(f.editor, first, 'rebind must not reconstruct an already observed editor');

  const custom = new NativeEditor();
  const customFactory = () => custom;
  const cachedSet = f.ui.setEditorComponent.bind(f.ui);
  cachedSet(customFactory);
  assert.equal(f.ui.getEditorComponent(), customFactory);
  assert.equal(f.editor, custom);
  const operation = custom.onSubmit('/share');
  assert.equal(scope.active, true);
  pending.resolve();
  await operation;
  assert.equal(scope.active, false);
  cachedSet(undefined);
  assert.equal(f.editor, first);
  assert.deepEqual(first.history, ['retained native history']);
  assert.equal(f.ui.getEditorComponent(), undefined);
  pending = deferred();
  const restored = first.onSubmit('/bug');
  assert.equal(scope.active, true);
  pending.resolve();
  await restored;
  assert.equal(scope.active, false);
});

test('native diagnostic failure releases activity but unsupported detached completion invalidates the host', async () => {
  const scope = createPromptScope({ Editor: NativeEditor });
  const failure = new Error('synthetic native failure');
  const f = nativeUI(() => Promise.reject(failure));
  scope.installEditor(f.ui);
  await assert.rejects(f.editor.onSubmit('/share'), error => error === failure);
  assert.equal(scope.active, false);

  const unknown = nativeUI(() => undefined);
  scope.installEditor(unknown.ui);
  await unknown.editor.onSubmit('/bug');
  assert.equal(scope.active, true, 'void callback completion cannot prove the native question finished');
});

test('detected submission-accessor and editor-API loss cannot be repaired into fresh consent', () => {
  for (const kind of ['callback', 'editor-api']) {
    const scope = createPromptScope({ Editor: NativeEditor });
    const f = nativeUI(async () => {});
    scope.installEditor(f.ui);
    const target = kind === 'callback' ? f.editor : f.ui;
    const name = kind === 'callback' ? 'onSubmit' : 'setEditorComponent';
    const original = Object.getOwnPropertyDescriptor(target, name);
    Object.defineProperty(target, name, { value() {}, configurable: true, writable: true });
    scope.snapshot();
    Object.defineProperty(target, name, original);
    scope.installEditor(f.ui);
    assert.equal(scope.active, true, kind);
  }
});

test('unsupported callback accessors or nonconfigurable slots are refused rather than bypassing a custom editor', () => {
  for (const descriptor of [
    { get() { return undefined; }, set() { assert.fail('Do not bypass or invoke the user accessor'); }, configurable: true },
    { value: undefined, writable: true, configurable: false },
  ]) {
    const scope = createPromptScope({ Editor: NativeEditor });
    const f = nativeUI(async () => {});
    const editor = new NativeEditor();
    Object.defineProperty(editor, 'onSubmit', descriptor);
    scope.installEditor(f.ui);
    assert.throws(() => f.ui.setEditorComponent(() => editor), /configurable data onSubmit/);
    assert.equal(scope.active, true);
  }
});
