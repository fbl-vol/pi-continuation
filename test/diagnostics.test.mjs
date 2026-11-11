import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diagnostics } from '../src/diagnostics.mjs';

test('failure reports preserve causes privately and expose only bounded classifications', () => {
  const report = diagnostics('worker');
  const output = [];
  const cause = Object.assign(new Error('secret checkpoint contents at /private/path'), { code: 'ENOSPC' });
  const error = report('persist observation', cause, { ui: { notify: (...args) => output.push(args) } });
  assert.equal(report.cause, cause);
  assert.equal(report.lastError, error);
  assert.deepEqual(report.last, { role: 'worker', operation: 'persist observation', code: 'ENOSPC' });
  assert.match(output[0][0], /persist observation.*ENOSPC/);
  assert.equal(output[0][1], 'error');
  assert.doesNotMatch(JSON.stringify(output) + error.message, /secret|private\/path/);
  const unknown = report('restore', Object.assign(new Error('sensitive'), { code: 'sensitive' }));
  assert.equal(unknown.code, 'UNEXPECTED');
  assert.doesNotMatch(unknown.message, /sensitive/);
  assert.doesNotThrow(() => report('restore', new Error(), { ui: { notify: () => { throw new Error(); } } }));
});
