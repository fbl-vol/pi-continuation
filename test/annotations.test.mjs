import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createAnnotations } from '../src/annotations.mjs';
import { newSupervisor } from '../src/contracts.mjs';
import { atomicJson } from '../src/store.mjs';

async function fixture(t, options = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'continuation-annotations-')));
  const id = randomUUID(), sessionId = randomUUID(), file = join(root, 'worker.jsonl');
  await writeFile(file, '{}\n');
  const state = newSupervisor();
  Object.assign(state, { ownerToken: randomUUID(), supervisorSession: randomUUID(), paused: false });
  state.routes.w = { paused: false };
  const binding = { workerId: id, sessionId, sessionFile: file, cwd: root,
    paneId: 'w:p1', terminalId: 'terminal', workspaceId: 'w', tabId: 'w:t1',
    sessionKind: 'path', sessionValue: file, route: 'w', paused: false };
  state.workers[id] = binding;
  const observation = { schemaVersion: 1, session: { id: sessionId, file },
    version: 1, outcome: 'working', hold: false, stop: null };
  const saveObservation = () => atomicJson(join(root, `observation-${id}.json`), observation);
  await saveObservation();
  const live = { protocol: 22, workspaces: [{ workspace_id: 'w', label: 'Synthetic workspace' }],
    agents: [{ agent: 'pi', pane_id: 'w:p1', terminal_id: 'terminal', workspace_id: 'w',
      tab_id: 'w:t1', cwd: root, agent_status: 'working',
      agent_session: { source: 'herdr:pi', agent: 'pi', kind: 'path', value: file } }] };
  const ownerFile = join(root, 'owner.jsonl');
  const ownerBinding = { paneId: 'w:p0', terminalId: 'owner', workspaceId: 'w', tabId: 'w:t1',
    cwd: root, sessionId: state.supervisorSession, sessionFile: ownerFile,
    sessionKind: 'path', sessionValue: ownerFile };
  live.agents.push({ ...live.agents[0], pane_id: ownerBinding.paneId, terminal_id: ownerBinding.terminalId,
    agent_session: { ...live.agents[0].agent_session, value: ownerFile } });
  const calls = [], errors = [];
  let clock = 0;
  const transport = async (_socket, method, params) => { calls.push({ method, params: structuredClone(params) }); return { type: 'ok' }; };
  const overrides = typeof options === 'function' ? options({ root, state, binding, ownerBinding, live, calls }) : options;
  const reporter = createAnnotations({ root, socketPath: 'fake', ownerToken: state.ownerToken, ownerBinding,
    readState: () => structuredClone(state), readSnapshot: async () => structuredClone(live),
    transport, now: () => clock, onError: error => errors.push(error), ...overrides });
  t.after(async () => { await reporter.close(); await rm(root, { recursive: true, force: true }); });
  return { root, state, binding, ownerBinding, observation, live, reporter, calls, errors, saveObservation,
    clock: value => { clock = value; } };
}

const paneCalls = f => f.calls.filter(c => c.method === 'pane.report_metadata' && c.params.pane_id === f.binding.paneId);
const ownerCalls = f => f.calls.filter(c => c.method === 'pane.report_metadata' && c.params.pane_id === f.ownerBinding.paneId);

test('a missing initial owner witness disables all display reports without mutating supervision', async t => {
  const f = await fixture(t, { ownerBinding: undefined });
  const before = structuredClone(f.state);
  await f.reporter.refresh();
  f.clock(5000);
  await f.reporter.refresh();
  await f.reporter.close();
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.state, before);
  assert.deepEqual(f.errors, [], 'Unavailable annotations are not a control failure');
});

test('verified workers and separate workspace summaries publish only expiring namespaced display values', async t => {
  const f = await fixture(t);
  const before = structuredClone(f.state);
  await f.reporter.refresh();
  assert.equal(paneCalls(f)[0].params.tokens.pi_continuation, 'Supervised');
  assert.equal(f.calls.find(c => c.method === 'workspace.report_metadata').params.tokens.pi_continuation_summary, '1 worker');
  for (const { method, params } of f.calls) {
    assert.equal(params.ttl_ms, 15000);
    assert.match(params.source, /^pi-continuation:[a-f0-9]{16}$/);
    assert.equal(params.source.includes(f.state.ownerToken), false);
    assert.ok(Object.keys(params.tokens).every(k => /^pi_continuation/.test(k)));
    assert.equal(params.agent_status, undefined);
    assert.equal(params.state_labels, undefined);
    assert.equal(params.title, undefined);
    assert.equal(params.display_agent, undefined);
    if (method.startsWith('pane.')) assert.equal(params.applies_to_source, 'herdr:pi');
  }
  assert.deepEqual(f.state, before);
  assert.equal(f.errors.length, 0);
});

test('unchanged metadata events do not self-republish; bounded renewal increases sequence and shutdown clears only owned tokens', async t => {
  const f = await fixture(t);
  await f.reporter.refresh();
  const count = f.calls.length;
  await f.reporter.refresh();
  assert.equal(f.calls.length, count);
  f.clock(5000);
  await f.reporter.refresh();
  assert.equal(f.calls.length, count * 2);
  const source = f.calls[0].params.source;
  await Promise.all([f.reporter.close(), f.reporter.close()]);
  assert.equal(f.calls.length, count * 3);
  assert.ok(f.calls.slice(-count).every(c => Object.values(c.params.tokens).every(v => v === null)));
  assert.ok(f.calls.every(c => c.params.source === source));
  assert.ok(f.calls.every((c, i) => !i || c.params.seq > f.calls[i - 1].params.seq));
  const closedCount = f.calls.length;
  await f.reporter.refresh();
  assert.equal(f.calls.length, closedCount);
});

test('error holds and independent global pause remain separate from native working activity', async t => {
  const f = await fixture(t);
  f.observation.hold = true;
  f.observation.holdReason = 'error';
  await f.saveObservation();
  await f.reporter.refresh();
  assert.equal(paneCalls(f).at(-1).params.tokens.pi_continuation_attention, 'Held: error');
  assert.equal(f.calls.at(-1).params.tokens.pi_continuation_summary, '1 worker · 1 held');
  f.observation.hold = false;
  delete f.observation.holdReason;
  await f.saveObservation();
  f.state.paused = true;
  await f.reporter.refresh();
  assert.equal(paneCalls(f).at(-1).params.tokens.pi_continuation_paused, 'Paused: global');
  assert.equal(f.live.agents[0].agent_status, 'working');
});

test('Stop and native identity replacement clear annotations, never follow the replacement or affect unrelated panes', async t => {
  const f = await fixture(t);
  f.live.agents.push({ ...f.live.agents[0], pane_id: 'w:p2' });
  await f.reporter.refresh();
  assert.ok(f.calls.filter(c => c.method === 'pane.report_metadata').every(c => ['w:p1', 'w:p0'].includes(c.params.pane_id)));
  f.binding.stopped = true;
  f.binding.paused = true;
  await f.reporter.refresh();
  assert.ok(f.calls.slice(-2).every(c => Object.values(c.params.tokens).every(v => v === null)));
  delete f.binding.stopped;
  f.binding.paused = false;
  await f.reporter.refresh();
  const beforeReplacement = f.calls.length;
  f.live.agents[0].agent_session.value = join(f.root, 'replacement.jsonl');
  await f.reporter.refresh();
  assert.ok(f.calls.slice(beforeReplacement).every(c => Object.values(c.params.tokens).every(v => v === null)));
});

test('owner replacement withdraws old reports; old reporter never adopts the new owner', async t => {
  const f = await fixture(t);
  await f.reporter.refresh();
  const prior = f.calls.length;
  f.state.ownerToken = randomUUID();
  await f.reporter.refresh();
  assert.ok(f.calls.slice(prior).every(c => Object.values(c.params.tokens).every(v => v === null)));
  const afterClear = f.calls.length;
  await f.reporter.refresh();
  assert.equal(f.calls.length, afterClear);
});

test('metadata transport failures are visible, bounded and never pause or mutate authoritative supervision', async t => {
  let fail = true;
  const f = await fixture(t, { transport: async () => { if (fail) throw new Error('synthetic metadata loss'); return { type: 'ok' }; } });
  const before = structuredClone(f.state);
  await f.reporter.refresh();
  await f.reporter.refresh();
  assert.equal(f.errors.length, 1);
  assert.deepEqual(f.state, before);
  fail = false;
  await f.reporter.refresh();
  assert.deepEqual(f.state, before);
});

test('closed pane and workspace cleanup is benign while surviving targets are still cleared', async t => {
  const f = await fixture(t, ({ calls }) => ({ transport: async (_socket, method, params) => {
    calls.push({ method, params: structuredClone(params) });
    if (Object.values(params.tokens).every(value => value === null)) {
      if (params.pane_id === 'w:p1') throw Object.assign(new Error('synthetic closed pane'), { code: 'pane_not_found' });
      if (method === 'workspace.report_metadata') throw Object.assign(new Error('synthetic closed workspace'), { code: 'workspace_not_found' });
    }
    return { type: 'ok' };
  } }));
  await f.reporter.refresh();
  const before = structuredClone(f.state);
  f.live.agents = f.live.agents.filter(agent => agent.pane_id !== 'w:p1');
  f.live.workspaces = [];
  await f.reporter.refresh();
  await f.reporter.close();
  assert.deepEqual(f.errors, []);
  assert.ok(ownerCalls(f).some(call => Object.values(call.params.tokens).every(value => value === null)));
  assert.deepEqual(f.state, before);
});

test('missing-target publication and unrelated cleanup failures remain visible', async t => {
  let failure;
  const f = await fixture(t, { transport: async () => {
    if (failure) throw failure;
    return { type: 'ok' };
  } });
  failure = Object.assign(new Error('synthetic publication target disappeared'), { code: 'pane_not_found' });
  await f.reporter.refresh();
  assert.equal(f.errors.length, 1, 'Only cleanup may ignore a missing target');
  failure = undefined;
  await f.reporter.refresh();
  failure = Object.assign(new Error('synthetic cleanup failure'), { code: 'invalid_metadata_source' });
  await f.reporter.close();
  assert.equal(f.errors.length, 2);
  assert.equal(f.errors[1], failure);
  assert.equal(f.binding.paused, false);
});

test('missing observations publish unknown rather than an eligible-looking active badge', async t => {
  const f = await fixture(t);
  await rm(join(f.root, `observation-${f.binding.workerId}.json`));
  await f.reporter.refresh();
  assert.equal(paneCalls(f)[0].params.tokens.pi_continuation_attention, 'Status unknown');
  assert.equal(paneCalls(f)[0].params.tokens.pi_continuation_active, null);
});

test('a pinned native supervisor gets its own badge, and replacement withdraws its whole display source', async t => {
  let replaceDuringRead = false, reads = 0;
  const f = await fixture(t, ({ live }) => ({ readSnapshot: async () => {
    if (replaceDuringRead && ++reads === 2) live.agents.find(a => a.pane_id === 'w:p0').terminal_id = 'replacement';
    return structuredClone(live);
  } }));
  await f.reporter.refresh();
  assert.equal(ownerCalls(f).at(-1).params.tokens.pi_continuation, 'Supervisor');
  f.state.paused = true;
  await f.reporter.refresh();
  assert.equal(ownerCalls(f).at(-1).params.tokens.pi_continuation, 'Supervisor: paused');
  const before = f.calls.length;
  f.live.agents.find(a => a.pane_id === 'w:p0').terminal_id = 'replacement';
  await f.reporter.refresh();
  assert.equal(f.calls.length - before, 3);
  assert.ok(f.calls.slice(before).every(c => Object.values(c.params.tokens).every(v => v === null)));
  f.live.agents.find(a => a.pane_id === 'w:p0').terminal_id = 'owner';
  replaceDuringRead = true;
  const cleared = f.calls.length;
  await f.reporter.refresh();
  assert.equal(reads, 2);
  assert.equal(f.calls.length, cleared, 'Near-publication owner replacement cannot leave worker badges');
});

test('native replacement between projection and publication refuses the stale badge without a hot retry', async t => {
  let reads = 0;
  const f = await fixture(t, ({ live }) => ({ readSnapshot: async () => {
    if (++reads === 2) live.agents[0].terminal_id = 'replacement';
    return structuredClone(live);
  } }));
  await f.reporter.refresh();
  assert.equal(reads, 2);
  assert.equal(f.calls.length, 0);
});

test('a delayed snapshot cannot publish after the pinned owner changes', async t => {
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, ({ live }) => ({ readSnapshot: async () => {
    entered(); await gate; return structuredClone(live);
  } }));
  const pending = f.reporter.refresh();
  await started;
  f.state.ownerToken = randomUUID();
  release();
  await pending;
  assert.equal(f.calls.length, 0);
});

test('a concurrent Pause supersedes slow metadata; no later report restores the old active label', async t => {
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, ({ calls }) => ({ transport: async (_socket, method, params) => {
    calls.push({ method, params: structuredClone(params) });
    if (calls.length === 1) { entered(); await gate; }
    return { type: 'ok' };
  } }));
  const pending = f.reporter.refresh();
  await started;
  f.state.paused = true;
  const changed = f.reporter.refresh();
  release();
  await Promise.all([pending, changed]);
  assert.equal(paneCalls(f).at(-1).params.tokens.pi_continuation, 'Paused: global');
  assert.ok(f.calls.slice(1).filter(c => c.method.startsWith('pane.')).every(c => c.params.tokens.pi_continuation_active === null));
});

test('a lost first acknowledgement still receives shutdown cleanup; another target can report normally', async t => {
  const f = await fixture(t, ({ calls }) => ({ transport: async (_socket, method, params) => {
    calls.push({ method, params: structuredClone(params) });
    if (calls.length === 1) throw new Error('synthetic lost acknowledgement');
    return { type: 'ok' };
  } }));
  await f.reporter.refresh();
  assert.equal(f.errors.length, 1);
  assert.ok(f.calls.some(c => c.method === 'workspace.report_metadata' && c.params.tokens.pi_continuation_summary === '1 worker'));
  await f.reporter.close();
  assert.ok(paneCalls(f).some(c => Object.values(c.params.tokens).every(v => v === null)));
  assert.equal(f.state.workers[f.binding.workerId].paused, false);
});

test('an unverified ownership handoff withdraws stale display without changing worker authority', async t => {
  const f = await fixture(t);
  await f.reporter.refresh();
  const before = f.calls.length;
  f.binding.handoff = { root: 'synthetic-invalid-reference' };
  await f.reporter.refresh();
  assert.ok(f.calls.slice(before).every(c => Object.values(c.params.tokens).every(v => v === null)));
  assert.equal(f.errors.length, 1);
  assert.equal(f.errors[0].code, 'OWNERSHIP_FENCE');
  assert.equal(f.binding.paused, false);
});
