import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { workerArgs, runWorker } from '../src/worker.mjs';

const workerURL = new URL('../src/worker.mjs', import.meta.url).href;

test('worker session flags are unambiguous and unknown arguments never become initial messages', () => {
  assert.deepEqual(workerArgs(['--session', 'saved.jsonl']), { recent: false, help: false, session: 'saved.jsonl' });
  assert.equal(workerArgs(['--continue']).recent, true);
  for (const args of [['--session'], ['--session', '--continue'], ['--session', 'a', '--session', 'b'],
    ['--session', 'a', '--continue'], ['--model', 'other'], ['unrequested initial task']]) {
    assert.throws(() => workerArgs(args));
  }
});

test('help and a headless launch cannot reach SDK configuration or credentials', () => {
  const script = `import assert from 'node:assert/strict';
import { runWorker } from ${JSON.stringify(workerURL)};
const sdk = new Proxy({}, { get() { throw new Error('SDK must not be accessed'); } });
await runWorker(['--help'], { sdk });
await assert.rejects(runWorker([], { sdk }), /interactive terminal/);
console.log('NO_SDK_ACCESS');`;
  const result = execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
  assert.match(result, /Experimental: not accepted for real-worker reliance/);
  assert.match(result, /NO_SDK_ACCESS/);
});

test('a saved working directory must exist before native resources or credentials can load', async () => {
  const root = await mkdtemp(join(tmpdir(), 'continuation-cli-cwd-'));
  try {
    const session = join(root, 'saved.jsonl');
    await writeFile(session, 'synthetic saved-session fixture');
    let target = join(root, 'missing-project');
    const sdk = new Proxy({ SessionManager: { open: () => ({ getCwd: () => target }) } }, {
      get(object, name) {
        assert.equal(name, 'SessionManager', 'No SDK resources, configuration or credentials before cwd validation');
        return object[name];
      },
    });
    await assert.rejects(runWorker(['--session', session], { sdk, terminal: {} }), { code: 'ENOENT' });
    target = session;
    await assert.rejects(runWorker(['--session', session], { sdk, terminal: {} }), /must be a directory/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a missing, empty or directory session fails before SDK discovery instead of creating another session', async () => {
  const root = await mkdtemp(join(tmpdir(), 'continuation-cli-'));
  try {
    const sdk = new Proxy({}, { get() { assert.fail('Missing file must reject before SDK access'); } });
    await assert.rejects(runWorker(['--session', join(root, 'missing.jsonl')], { sdk, terminal: {} }), { code: 'ENOENT' });
    const empty = join(root, 'empty.jsonl');
    await writeFile(empty, '');
    for (const file of [root, empty]) {
      await assert.rejects(runWorker(['--session', file], { sdk, terminal: {} }), /non-empty saved session file/);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
