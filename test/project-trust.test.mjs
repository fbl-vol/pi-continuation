import test from 'node:test';
import assert from 'node:assert/strict';
import { createProjectTrustResolver } from '../src/project-trust.mjs';

function fixture({ decision = 'ask', hasUI = true, hasResources = true, handlers = [], choose = 0 } = {}) {
  const saved = new Map();
  let questions = 0;
  const failures = [];
  const sdk = { hasTrustRequiringProjectResources: () => hasResources,
    ProjectTrustStore: class {
      get(cwd) { return saved.get(cwd) ?? null; }
      set(cwd, value) { saved.set(cwd, value); }
    } };
  const context = { hasUI, ui: { select: async (_title, options) => { questions++; return options[choose]; } } };
  const input = { cwd: '/synthetic/project', context,
    settingsManager: { getDefaultProjectTrust: () => decision },
    extensionsResult: { extensions: [{ handlers: new Map([['project_trust', handlers]]) }] } };
  return { resolve: createProjectTrustResolver(sdk, '/synthetic/agent', (...args) => failures.push(args)),
    input, saved, failures, questions: () => questions };
}

test('unknown executable projects are not trusted without a UI and explicit native defaults remain effective', async () => {
  for (const [decision, expected] of [['ask', false], ['never', false], ['always', true]]) {
    const f = fixture({ decision, hasUI: false });
    assert.equal(await f.resolve(f.input), expected);
    assert.equal(f.questions(), 0);
    assert.equal(f.saved.size, 0);
  }
});

test('a process-only choice does not write native trust and a later native store update is honored', async () => {
  const f = fixture();
  assert.equal(await f.resolve(f.input), true);
  assert.equal(f.saved.size, 0);
  assert.equal(await f.resolve(f.input), true);
  assert.equal(f.questions(), 1);
  f.saved.set(f.input.cwd, false);
  assert.equal(await f.resolve(f.input), false);
  assert.equal(f.questions(), 1);
});

test('only an explicit remember choice persists trust; cancellation and no-resource folders do not', async () => {
  const remembered = fixture({ choose: 1 });
  assert.equal(await remembered.resolve(remembered.input), true);
  assert.equal(remembered.saved.get(remembered.input.cwd), true);
  const cancelled = fixture({ choose: -1 });
  assert.equal(await cancelled.resolve(cancelled.input), false);
  assert.equal(cancelled.saved.size, 0);
  const empty = fixture({ hasResources: false, hasUI: false });
  assert.equal(await empty.resolve(empty.input), true);
  assert.equal(empty.saved.size, 0);
  empty.saved.set(empty.input.cwd, false);
  assert.equal(await empty.resolve(empty.input), false);
});

test('trust dispatch snapshots every handler before a callback can register another decision', async () => {
  const later = [];
  const f = fixture({ hasUI: false, handlers: [() => {
    later.push(() => ({ trusted: 'yes' }));
    return { trusted: 'undecided' };
  }] });
  f.input.extensionsResult.extensions.push({ handlers: new Map([['project_trust', later]]) });
  assert.equal(await f.resolve(f.input), false);
  assert.equal(await f.resolve(f.input), true, 'new handler takes effect on the next resolution only');
});

test('global project_trust handlers retain first-decision priority and errors do not confer trust', async () => {
  let ignored = 0;
  const f = fixture({ handlers: [
    () => { throw new Error('synthetic handler failure'); },
    () => ({ trusted: 'undecided' }),
    () => ({ trusted: 'invalid' }),
    (_event, ctx) => { assert.equal(ctx, f.input.context); return { trusted: 'no', remember: true }; },
    () => { ignored++; return { trusted: 'yes' }; },
  ] });
  assert.equal(await f.resolve(f.input), false);
  assert.equal(f.failures.length, 2);
  assert.equal(f.failures[0][2], f.input.context);
  assert.equal(f.saved.get(f.input.cwd), false);
  assert.equal(f.questions(), 0);
  assert.equal(ignored, 0);
});
