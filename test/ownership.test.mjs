import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { atomicJson, ensureRoot, readJson } from '../src/store.mjs';
import { prepareHandoff, inspectHandoff, withHandoff, withWorkerHandoff, rollbackHandoff } from '../src/ownership.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'continuation-fence-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, 'new-state', 'ownership');
  const identity = { sessionId: randomUUID(), sessionFile: join(directory, 'session.jsonl'),
    checkpoint: join(directory, 'checkpoint.md') };
  await writeFile(identity.sessionFile, '{}\n');
  await writeFile(identity.checkpoint, 'Existing approved assignment');
  const target = { root: join(directory, 'new-state'), workerId: randomUUID() };
  const registry = join(directory, 'old.json');
  const oldWorker = { mode: 'active', nudges: 2, pause: 'retained reason',
    pendingNotice: { kind: 'decision' }, history: ['old-stop'] };
  await atomicJson(registry, { selected: oldWorker, sibling: { mode: 'active', progress: 4 } });
  const reserve = async record => {
    const state = await readJson(registry);
    state.selected = { ...state.selected, mode: 'paused', handoffId: record.handoffId };
    await atomicJson(registry, state);
  };
  const restore = async () => {
    const state = await readJson(registry);
    state.selected = { ...oldWorker, mode: 'paused' };
    await atomicJson(registry, state);
  };
  return { root, identity, target, registry, oldWorker, reserve, restore };
}

const referenceFor = (root, record) => ({ root, handoffId: record.handoffId,
  identity: record.identity, target: record.target });

test('selected transfer preserves old evidence and sibling changes; rollback leaves old worker paused', async t => {
  const f = await fixture(t);
  const reference = await prepareHandoff(f.root, f, f.reserve);
  const reserved = await readJson(f.registry);
  assert.deepEqual(reserved.selected, { ...f.oldWorker, mode: 'paused', handoffId: reference.handoffId });
  assert.deepEqual(reserved.sibling, { mode: 'active', progress: 4 });
  assert.equal(await withHandoff(reference, {}, () => 'eligible'), 'eligible');
  // Sibling supervision continues after reservation; rollback cannot restore a whole registry snapshot.
  reserved.sibling.progress = 5;
  await atomicJson(f.registry, reserved);
  await rollbackHandoff(reference, f.restore);
  assert.deepEqual((await readJson(f.registry)).selected, { ...f.oldWorker, mode: 'paused' });
  assert.equal((await readJson(f.registry)).sibling.progress, 5);
  assert.equal((await inspectHandoff(f.root, reference.identity.sessionFile)).phase, 'returned');
  await assert.rejects(withHandoff(reference, {}, () => assert.fail('retired new owner ran')), /not the selected/);
  await assert.rejects(prepareHandoff(f.root, f, f.reserve), { code: 'EEXIST' });
});

test('standalone delivery and preparation share one mutex and cannot erase earlier uncertain effects', async t => {
  const f = await fixture(t);
  await ensureRoot(f.target.root);
  const binding = { sessionFile: f.identity.sessionFile };
  await withWorkerHandoff(f.target.root, f.target.workerId, binding, { effect: true }, async () => {
    await assert.rejects(prepareHandoff(f.root, f, f.reserve), /worker busy or abandoned lock/);
  });
  await assert.rejects(prepareHandoff(f.root, f, f.reserve), /standalone delivery already attempted/);
});

test('interrupted reserve blocks both owners and can roll back without publishing new ownership', async t => {
  const f = await fixture(t);
  await assert.rejects(prepareHandoff(f.root, f, async () => { throw new Error('old write failed'); }), /old write/);
  const record = await inspectHandoff(f.root, f.identity.sessionFile);
  assert.equal(record.phase, 'prepared');
  const reference = referenceFor(f.root, record);
  await assert.rejects(withHandoff(reference, {}, () => assert.fail('prepared owner ran')), /not the selected/);
  await rollbackHandoff(reference, f.restore);
  assert.equal((await readJson(f.registry)).selected.mode, 'paused');
});

test('interrupted rollback keeps new owner fenced and retries only the paused restoration', async t => {
  const f = await fixture(t);
  const reference = await prepareHandoff(f.root, f, f.reserve);
  await assert.rejects(rollbackHandoff(reference, async () => { throw new Error('restore failed'); }), /restore failed/);
  assert.equal((await inspectHandoff(f.root, reference.identity.sessionFile)).phase, 'returning');
  await assert.rejects(withHandoff(reference, {}, () => assert.fail('returning owner ran')), /not the selected/);
  await rollbackHandoff(reference, f.restore);
  assert.equal((await readJson(f.registry)).selected.mode, 'paused');
});

test('any attempted effect durably forbids rollback, including an uncertain send', async t => {
  const f = await fixture(t);
  const reference = await prepareHandoff(f.root, f, f.reserve);
  await assert.rejects(withHandoff(reference, { effect: true }, async () => {
    assert.equal((await inspectHandoff(f.root, reference.identity.sessionFile)).used, true);
    throw new Error('send outcome uncertain');
  }), /send outcome uncertain/);
  await assert.rejects(rollbackHandoff(reference, () => assert.fail('must not restore old snapshot')), /unused exact/);
  assert.equal((await inspectHandoff(f.root, reference.identity.sessionFile)).phase, 'owned');
});

test('independent checkpoint or session progress refuses snapshot rollback without a new delivery', async t => {
  for (const changedFile of ['checkpoint', 'sessionFile']) {
    const f = await fixture(t);
    const reference = await prepareHandoff(f.root, f, f.reserve);
    await writeFile(reference.identity[changedFile], 'New independent worker evidence');
    await assert.rejects(rollbackHandoff(reference, () => assert.fail('discarded independent progress')), /progressed/);
    assert.equal((await inspectHandoff(f.root, reference.identity.sessionFile)).phase, 'owned');
  }
});

test('wrong target, replaced identity and missing witness never authorize continuation', async t => {
  const f = await fixture(t);
  const reference = await prepareHandoff(f.root, f, f.reserve);
  for (const wrong of [
    { ...reference, handoffId: randomUUID() },
    { ...reference, target: { ...reference.target, workerId: randomUUID() } },
    { ...reference, identity: { ...reference.identity, sessionId: randomUUID() } },
    { ...reference, identity: { ...reference.identity, checkpoint: f.identity.sessionFile } },
  ]) await assert.rejects(withHandoff(wrong, {}, () => assert.fail('wrong owner ran')), /not the selected/);
  await rm(reference.identity.sessionFile);
  await assert.rejects(withHandoff(reference, {}, () => assert.fail('missing session ran')), { code: 'ENOENT' });
  await assert.rejects(inspectHandoff(f.root, join(f.root, 'other-session')), { code: 'ENOENT' });
});

test('competing process cannot roll back during a new-owner effect', async t => {
  const f = await fixture(t);
  const reference = await prepareHandoff(f.root, f, f.reserve);
  const module = new URL('../src/ownership.mjs', import.meta.url).href;
  let child;
  await withHandoff(reference, { effect: true }, async () => {
    child = spawn(process.execPath, ['--input-type=module', '-e', `
      import { rollbackHandoff } from ${JSON.stringify(module)};
      try { await rollbackHandoff(${JSON.stringify(reference)}, () => {}); process.exitCode = 9; }
      catch (e) { console.log(e.message); }
    `], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    const [code] = await once(child, 'exit');
    assert.equal(code, 0);
    assert.match(output, /worker busy or abandoned lock/);
  });
  await assert.rejects(rollbackHandoff(reference, f.restore), /unused exact/);
});

test('a crashed process leaves its mutex held until inspected, never age-based recovery', async t => {
  const f = await fixture(t);
  const reference = await prepareHandoff(f.root, f, f.reserve);
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { withHandoff } from ${JSON.stringify(new URL('../src/ownership.mjs', import.meta.url).href)};
    await withHandoff(${JSON.stringify(reference)}, {}, () => process.exit(0));
  `]);
  const [code] = await once(child, 'exit');
  assert.equal(code, 0);
  await assert.rejects(withHandoff(reference, {}, () => assert.fail('stole abandoned lock')), /abandoned lock/);
  await assert.rejects(rollbackHandoff(reference, f.restore), /abandoned lock/);
});
