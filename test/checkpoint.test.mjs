import test from 'node:test';
import assert from 'node:assert/strict';
import { managedCheckpointText } from '../src/checkpoint.mjs';

const message = (id, role, content) => ({ id, type: 'message', message: { role, content } });

function retainedSession() {
  const previous = message('a', 'user', 'Old assignment and its previous approval.');
  const boundary = { id: 'boundary', type: 'custom', customType: 'pi-continuation-worker' };
  const scope = message('b', 'user', 'New assignment without inherited approval.');
  const reply = message('result', 'assistant', 'Draft from B before context edit.');
  const summary = { id: 'summary', type: 'compaction' };
  const projection = [
    { sourceEntry: previous, messages: [previous.message] },
    { sourceEntry: boundary, messages: [] },
    { sourceEntry: scope, messages: [scope.message] },
    { sourceEntry: reply, messages: [{ role: 'assistant', content: 'Current result for B.' }] },
    { sourceEntry: summary, messages: [{ role: 'compactionSummary', summary: 'Summary could include both assignments.' }] },
  ];
  const branch = [previous, boundary, scope, reply, summary];
  return { sessionManager: { getBranch: () => branch,
    buildSessionProjection: () => ({ entries: projection, messages: projection.flatMap(entry => entry.messages) }) } };
}

test('a retained session checkpoint excludes prior assignment and cross-boundary summaries', () => {
  const ctx = retainedSession();
  assert.match(managedCheckpointText(ctx), /Old assignment/);
  const result = managedCheckpointText(ctx, 'boundary');
  assert.match(result, /New assignment/);
  assert.match(result, /Current result for B/);
  assert.doesNotMatch(result, /Old assignment|Summary could include|Draft from B/);
});

test('an unreachable assignment boundary cannot fall back to prior history', () => {
  const ctx = retainedSession();
  assert.throws(() => managedCheckpointText(ctx, 'different-branch'), /does not contain the assignment checkpoint boundary/);
});
