import test from 'node:test';
import assert from 'node:assert/strict';
import { createPromptScope } from '../src/prompt-scope.mjs';

function missingCwd() {
  const error = new Error('Synthetic missing working directory');
  error.name = 'MissingSessionCwdError';
  return error;
}

test('a missing-cwd transition fences the later native question before its rejection reaches the frontend', async () => {
  for (const method of ['switchSession', 'importFromJsonl']) {
    const scope = createPromptScope();
    const error = missingCwd();
    const runtime = { async switchSession() {}, async importFromJsonl() {} };
    let missing = true;
    runtime[method] = function () { if (missing) throw error; return Promise.resolve({ cancelled: false }); };
    let signals = 0;
    scope.subscribe(() => { signals++; });
    scope.observeSessionTransitions(runtime);
    scope.observeSessionTransitions(runtime);

    await assert.rejects(runtime[method]('/synthetic/target'), received => {
      assert.equal(scope.active, true, 'the frontend must not open an unheld native question');
      return received === error;
    });
    assert.equal(signals, 1);
    // The backend operation has ended; it cannot tell whether the frontend's
    // subsequent question was cancelled, hidden or answered. Do not rearm it.
    missing = false;
    await runtime[method]('/synthetic/resolved-target');
    assert.equal(scope.active, true);
    assert.equal(signals, 1);
    assert.equal(createPromptScope().active, false, 'only a new host establishes a fresh boundary');
  }
});

test('valid and cancelled native transitions keep their receiver, arguments and opaque result without a prompt lease', async () => {
  const scope = createPromptScope();
  const options = Object.freeze({ opaque: true });
  const result = Object.freeze({ cancelled: true });
  let received;
  const runtime = { async switchSession(...args) { received = { receiver: this, args }; return result; },
    async importFromJsonl() {} };
  scope.observeSessionTransitions(runtime);
  const before = scope.snapshot();
  assert.equal(await runtime.switchSession('/synthetic/saved', options), result);
  assert.equal(received.receiver, runtime);
  assert.equal(received.args[0], '/synthetic/saved');
  assert.equal(received.args[1], options);
  assert.equal(scope.active, false);
  assert.deepEqual(scope.snapshot(), before);
});

test('other transition failures are preserved without reading an opaque error name getter', async () => {
  const scope = createPromptScope();
  const error = new Error('Synthetic resource failure');
  Object.defineProperty(error, 'name', { get() { assert.fail('No error getter evaluation'); } });
  const runtime = { async switchSession() { throw error; }, async importFromJsonl() {} };
  scope.observeSessionTransitions(runtime);
  await assert.rejects(runtime.switchSession('/synthetic/target'), received => received === error);
  assert.equal(scope.active, false);
});

test('detected transition-observer displacement remains fenced after method restoration', () => {
  const scope = createPromptScope();
  const runtime = { async switchSession() {}, async importFromJsonl() {} };
  scope.observeSessionTransitions(runtime);
  const observed = runtime.switchSession;
  runtime.switchSession = async () => {};
  scope.snapshot();
  runtime.switchSession = observed;
  scope.observeSessionTransitions(runtime);
  assert.equal(scope.active, true);
});
