import test from 'node:test';
import assert from 'node:assert/strict';
import { blindJudgmentCases, checkJudgments } from '../scripts/judgment.mjs';

const evidence = row => JSON.parse(row.attention.slice(row.attention.lastIndexOf('[{"id":')))[0];

test('behavioral review uses production attention/tool contracts without revealing expected answers', () => {
  const input = blindJudgmentCases();
  assert.equal(input.tool.name, 'continuation_disposition');
  assert.equal(input.cases.length, 12);
  assert.equal(JSON.stringify(input).includes('"expected"'), false);
  const first = evidence(input.cases[0]);
  assert.match(first.finalReply, /regression test/);
  assert.equal(first.outcome, 'completed');
  assert.equal(evidence(input.cases[10]).outcome, 'aborted');
});

test('the checker rejects a mistaken resume despite valid checkpoint evidence and exact identity', () => {
  const input = blindJudgmentCases();
  const row = input.cases[1];
  const stop = evidence(row);
  const result = checkJudgments([{ caseId: row.caseId, arguments: {
    workerId: stop.id, stop: stop.stop, action: 'resume', evidence: stop.checkpoint,
  } }]);
  assert.ok(result.failures.includes('case-2: unexpected resume disposition'));
  assert.equal(result.checked, 1);
});

test('permitted model choices still need exact identities, evidence and completion freshness', () => {
  const input = blindJudgmentCases();
  const question = evidence(input.cases[1]);
  const completion = evidence(input.cases[5]);
  const results = [
    { caseId: 'case-2', arguments: { workerId: question.id, stop: question.stop,
      action: 'notify', kind: 'decision', evidence: question.finalReply } },
    { caseId: 'case-6', arguments: { workerId: completion.id, stop: completion.stop,
      action: 'acknowledge', evidence: completion.checkpoint, reportHash: completion.reportHash } },
  ];
  let report = checkJudgments(results);
  assert.equal(report.failures.some(f => /^case-(2|6):/.test(f)), false);
  results[0].arguments.workerId = completion.id;
  delete results[1].arguments.reportHash;
  report = checkJudgments(results);
  assert.ok(report.failures.includes('case-2: wrong identity or missing evidence'));
  assert.ok(report.failures.some(f => f.startsWith('case-6: Checkpoint changed or report hash missing')));
});
