import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdtemp, mkdir, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createContinuationRuntime } from '../src/runtime.mjs';

function managerFixture(context = {}, branch = []) {
  return { buildSessionContext: () => ({ messages: [], model: null, thinkingLevel: 'off', ...context }),
    getBranch: () => branch };
}

function sdkFixture({ fallback = false, available = true, configuredAuth = true, extensions = [], errors = [] } = {}) {
  const calls = { settings: [], loads: [], disposed: 0, settled: 0 };
  let factory;
  const sdk = {
    VERSION: '1.5.2', CustomEditor: class {},
    getAgentDir: () => '/synthetic/agent',
    ProjectTrustStore: class { get() { return null; } },
    hasTrustRequiringProjectResources: () => false,
    SettingsManager: { create(cwd, agentDir, options) {
      calls.settings.push({ cwd, agentDir, ...options });
      return { getDefaultProjectTrust: () => 'ask' };
    } },
    createCodemodeExtension: () => () => {},
    createToolSearchExtension: () => () => {},
    createMcpExtension: () => () => {},
    async createAgentSessionServices(options) {
      const loaded = [];
      for (const entry of options.resourceLoaderOptions.extensionFactories) {
        const extension = { path: `<inline:${entry.name}>`, resolvedPath: `<inline:${entry.name}>`,
          commands: new Map(), tools: new Map(), flags: new Map(), shortcuts: new Map(), handlers: new Map() };
        entry.factory({ on(name, handler) {
          const handlers = extension.handlers.get(name) ?? [];
          extension.handlers.set(name, [...handlers, handler]);
        }, registerCommand(name, command) { extension.commands.set(name, command); },
        registerTool(tool) { extension.tools.set(tool.name, tool); } });
        loaded.push(extension);
      }
      const base = { extensions: [...extensions, ...loaded], errors, runtime: {} };
      const trusted = await options.resourceLoaderReloadOptions.resolveProjectTrust({ extensionsResult: base });
      const result = options.resourceLoaderOptions.extensionsOverride(base);
      calls.loads.push({ options, result, trusted });
      return { resourceLoader: { getExtensions: () => result }, diagnostics: [], modelRuntime: {
        getModel: (provider, id) => available ? { provider, id } : undefined,
        hasConfiguredAuth: () => configuredAuth,
        login: async () => undefined,
        async settleCredentialWrites() { calls.settled++; },
      } };
    },
    async createAgentSessionFromServices(options) {
      calls.session = options;
      return { session: { model: options.model ?? { provider: 'synthetic', id: 'B' },
        thinkingLevel: options.thinkingLevel ?? 'low', dispose() { calls.disposed++; } },
        ...(fallback ? { modelFallbackMessage: 'Synthetic unavailable model' } : {}) };
    },
    async createAgentSessionRuntime(callback, options) {
      factory = callback;
      const result = await callback(options);
      return { ...result, async switchSession() {}, async importFromJsonl() {},
        async dispose() { result.session.dispose(); } };
    },
  };
  return { sdk, calls, replace: options => factory(options) };
}

test('SDK runtime starts project-untrusted and owns resource ordering without registering a worker', async () => {
  const unrelated = { path: '/synthetic/earlier', resolvedPath: '/synthetic/earlier',
    commands: new Map(), tools: new Map(), flags: new Map(), handlers: new Map(), shortcuts: new Map() };
  const f = sdkFixture({ extensions: [unrelated] });
  const manager = managerFixture();
  const host = await createContinuationRuntime(f.sdk, { cwd: '/synthetic/work', sessionManager: manager });
  assert.deepEqual(f.calls.settings, [{ cwd: '/synthetic/work', agentDir: '/synthetic/agent', projectTrusted: false }]);
  assert.equal(f.calls.loads[0].result.extensions[0].path, '<inline:pi-continuation-runtime>');
  assert.equal(f.calls.loads[0].result.extensions[1].path, unrelated.path);
  assert.equal(f.calls.session.sessionManager, manager);
  assert.equal(host.worker.registered, false);
  const id = host.promptScope.snapshot().id;
  await f.replace({ cwd: '/synthetic/other', sessionManager: managerFixture() });
  assert.equal(f.calls.settings[1].projectTrusted, false);
  assert.equal(f.calls.settings[1].cwd, '/synthetic/other');
  assert.equal(host.promptScope.snapshot().id, id);
  assert.equal(f.calls.loads[1].result.extensions[0].path, '<inline:pi-continuation-runtime>');
});

test('unverified SDK frontend versions are refused before native factories or services', async () => {
  const f = sdkFixture();
  f.sdk.VERSION = '1.5.3';
  f.sdk.createMcpExtension = () => assert.fail('No native factory on an unverified frontend');
  await assert.rejects(createContinuationRuntime(f.sdk, { cwd: '/synthetic/work', sessionManager: managerFixture() }),
    /verified Pi 1.5.2 frontend profile/);
  assert.deepEqual(f.calls.settings, []);
  assert.deepEqual(f.calls.loads, []);
});

test('a different agent directory is refused before native factories or services can read process configuration', async () => {
  const f = sdkFixture();
  f.sdk.createMcpExtension = () => assert.fail('No MCP factory before directory identity check');
  await assert.rejects(createContinuationRuntime(f.sdk, { cwd: '/synthetic/work', agentDir: '/synthetic/other',
    sessionManager: managerFixture() }), /must match the native process configuration/);
  assert.deepEqual(f.calls.settings, []);
  assert.deepEqual(f.calls.loads, []);
});

test('a filesystem alias of the native process directory remains usable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'continuation-agent-dir-'));
  try {
    const native = join(root, 'native'), alias = join(root, 'alias');
    await mkdir(native);
    await symlink(native, alias, 'junction');
    const f = sdkFixture();
    f.sdk.getAgentDir = () => native;
    await createContinuationRuntime(f.sdk, { cwd: root, agentDir: alias, sessionManager: managerFixture() });
    assert.equal(f.calls.settings[0].agentDir, native, 'native path spelling also preserves relative config resolution');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('resource overrides cannot remove the runtime guard or silently shadow continuation commands', async () => {
  const removed = sdkFixture();
  await assert.rejects(createContinuationRuntime(removed.sdk, { cwd: '/synthetic/work', sessionManager: managerFixture(),
    resourceLoaderOptions: { extensionsOverride: base => ({ ...base,
      extensions: base.extensions.filter(item => item.path !== '<inline:pi-continuation-runtime>') }) } }),
    /must load exactly once/);
  const conflict = sdkFixture({ extensions: [{ path: '/synthetic/conflict', resolvedPath: '/synthetic/conflict',
    handlers: new Map(), shortcuts: new Map(), tools: new Map(), flags: new Map(),
    commands: new Map([['continuation-worker', {}]]) }] });
  await assert.rejects(createContinuationRuntime(conflict.sdk, { cwd: '/synthetic/work', sessionManager: managerFixture() }),
    /registered by another extension/);
});

test('a discovered copy of this entry is deduplicated without hiding unknown errors or foreign tools', async () => {
  const file = fileURLToPath(new URL('../src/extension.ts', import.meta.url));
  const duplicate = { path: file, resolvedPath: file, commands: new Map(), flags: new Map(),
    tools: new Map([['continuation_disposition', {}]]), handlers: new Map(), shortcuts: new Map() };
  const collision = { path: '<inline:pi-continuation-runtime>',
    error: `Tool "continuation_disposition" conflicts with ${file}` };
  const f = sdkFixture({ extensions: [duplicate], errors: [collision] });
  await createContinuationRuntime(f.sdk, { cwd: '/synthetic/work', sessionManager: managerFixture() });
  assert.equal(f.calls.loads[0].result.extensions.some(item => item.path === file), false);
  assert.deepEqual(f.calls.loads[0].result.errors, []);

  const unexpected = { path: collision.path, error: 'Synthetic unrelated startup failure' };
  const broken = sdkFixture({ extensions: [duplicate], errors: [collision, unexpected] });
  await assert.rejects(createContinuationRuntime(broken.sdk, { cwd: '/synthetic/work', sessionManager: managerFixture() }),
    error => error.message.includes('resources failed') && error.cause.length === 1 && error.cause[0] === unexpected);
  const foreign = sdkFixture({ extensions: [{ ...duplicate, path: '/synthetic/other', resolvedPath: '/synthetic/other' }] });
  await assert.rejects(createContinuationRuntime(foreign.sdk, { cwd: '/synthetic/work', sessionManager: managerFixture() }),
    /registered by another extension/);
});

test('an unsupported transition surface disposes the constructed runtime instead of returning an unobserved host', async () => {
  const f = sdkFixture();
  const create = f.sdk.createAgentSessionRuntime;
  f.sdk.createAgentSessionRuntime = async (...args) => {
    const runtime = await create(...args);
    delete runtime.importFromJsonl;
    return runtime;
  };
  await assert.rejects(createContinuationRuntime(f.sdk, { cwd: '/synthetic/work', sessionManager: managerFixture() }),
    /Unsupported native session transition surface/);
  assert.equal(f.calls.disposed, 1);
});

test('runtime refuses an unobservable native auth surface before constructing a session', async () => {
  for (const [mutate, failure] of [
    [models => { delete models.login; }, /Unsupported model auth surface/],
    [Object.freeze, TypeError],
  ]) {
    const f = sdkFixture();
    const create = f.sdk.createAgentSessionServices;
    f.sdk.createAgentSessionServices = async options => {
      const services = await create(options);
      mutate(services.modelRuntime);
      return services;
    };
    await assert.rejects(createContinuationRuntime(f.sdk, { cwd: '/synthetic' }), failure);
    assert.equal(f.calls.session, undefined);
    assert.equal(f.calls.settled, 1);
  }
});

test('saved metadata-only model and thinking are pinned before the SDK can append its defaults', async () => {
  for (const [available, configuredAuth] of [[true, true], [false, true], [true, false]]) {
    const f = sdkFixture({ available, configuredAuth });
    const manager = managerFixture({ model: { provider: 'synthetic', modelId: 'A' }, thinkingLevel: 'high' },
      [{ type: 'thinking_level_change' }]);
    const pending = createContinuationRuntime(f.sdk, { cwd: '/synthetic/work', sessionManager: manager });
    if (available && configuredAuth) {
      const host = await pending;
      assert.deepEqual(host.runtime.session.model, { provider: 'synthetic', id: 'A' });
      assert.equal(host.runtime.session.thinkingLevel, 'high');
    } else {
      await assert.rejects(pending, /model could not be restored/);
      assert.equal(f.calls.session, undefined, 'SDK must not rewrite saved metadata with its fallback');
      assert.equal(f.calls.settled, 1);
    }
  }
});

test('a missing saved model fails closed instead of silently adopting the SDK fallback', async () => {
  const f = sdkFixture({ fallback: true });
  await assert.rejects(createContinuationRuntime(f.sdk, { cwd: '/synthetic/work', sessionManager: managerFixture() }),
    /model could not be restored/);
  assert.equal(f.calls.disposed, 1);
  assert.equal(f.calls.settled, 1);
});
