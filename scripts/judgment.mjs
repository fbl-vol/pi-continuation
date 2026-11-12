// Offline behavioral-review inputs/checker. Never calls a model or a live worker.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Check } from 'typebox/value';
import { attentionContent } from '../src/attention.mjs';
import { checkpointHash, planDisposition } from '../src/policy.mjs';
import { bindSupervisor } from '../src/supervisor.mjs';

const fixtures = JSON.parse(readFileSync(new URL('../test/fixtures/judgment.json', import.meta.url), 'utf8'));
const evidenceFor = (fixture, index) => ({
  id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
  stop: `11111111-1111-4111-8111-${String(index + 1).padStart(12, '0')}`,
  outcome: fixture.outcome ?? 'completed',
  checkpointPath: `/synthetic/case-${index + 1}.md`,
  reportHash: checkpointHash(fixture.checkpoint), finalReply: fixture.reply, checkpoint: fixture.checkpoint,
});

function dispositionTool() {
  let tool;
  // Factory registration is inert: no init command, socket, observer or model.
  bindSupervisor({ on() {}, registerCommand() {}, registerTool(definition) { tool = definition; } });
  return tool;
}

export function blindJudgmentCases() {
  const tool = dispositionTool();
  return {
    tool: { name: tool.name, description: tool.description, parameters: tool.parameters },
    cases: fixtures.map((fixture, index) => ({ caseId: `case-${index + 1}`,
      attention: attentionContent([evidenceFor(fixture, index)]) })),
  };
}

export function checkJudgments(results) {
  if (!Array.isArray(results)) throw new Error('Expected an array of judgments');
  const seen = new Set();
  const failures = [];
  const schema = dispositionTool().parameters;
  for (const result of results) {
    const index = /^case-([1-9][0-9]*)$/.exec(result?.caseId ?? '')?.[1];
    const fixture = fixtures[Number(index) - 1];
    if (!fixture || seen.has(result.caseId)) { failures.push('Unknown or duplicate case'); continue; }
    seen.add(result.caseId);
    const args = result.arguments;
    if (!Check(schema, args)) {
      failures.push(`${result.caseId}: arguments do not match the registered tool schema`); continue;
    }
    const evidence = evidenceFor(fixture, Number(index) - 1);
    const kind = args?.action === 'notify' ? args.kind : args?.action;
    if (!fixture.expected.includes(kind)) {
      failures.push(`${result.caseId}: unexpected ${kind ?? 'missing'} disposition`); continue;
    }
    if (args.workerId !== evidence.id || args.stop !== evidence.stop || typeof args.evidence !== 'string') {
      failures.push(`${result.caseId}: wrong identity or missing evidence`); continue;
    }
    const state = { workers: { [evidence.id]: { route: 'synthetic' } },
      routes: { synthetic: { coordinator: { id: 'synthetic-only' } } }, budgets: {}, notices: {} };
    const plan = planDisposition(state, args, fixture.checkpoint, fixture.reply);
    if (plan.kind === 'reject') failures.push(`${result.caseId}: ${plan.message}`);
  }
  for (let index = 0; index < fixtures.length; index++) {
    if (!seen.has(`case-${index + 1}`)) failures.push(`case-${index + 1}: missing disposition`);
  }
  return { checked: seen.size, failures };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [mode, path] = process.argv.slice(2);
  if (mode === '--blind') console.log(JSON.stringify(blindJudgmentCases(), null, 2));
  else if (mode === '--check' && path) {
    const result = checkJudgments(JSON.parse(readFileSync(path, 'utf8')));
    console.log(JSON.stringify(result, null, 2));
    if (result.failures.length) process.exitCode = 1;
  } else throw new Error('Usage: node scripts/judgment.mjs --blind | --check <results.json>');
}
