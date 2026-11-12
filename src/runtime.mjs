import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { realpath } from 'node:fs/promises';
import { bindObservation } from './observation.mjs';
import { bindSupervisor } from './supervisor.mjs';
import { bindCoordinator } from './coordinator.mjs';
import { createPromptScope } from './prompt-scope.mjs';
import { createProjectTrustResolver } from './project-trust.mjs';

const runtimeExtension = '<inline:pi-continuation-runtime>';
const extensionFile = fileURLToPath(new URL('./extension.ts', import.meta.url));
const modelRestoreFailure = 'Worker model could not be restored; select its model explicitly before retrying';

async function sameDirectory(left, right) {
  if (resolve(left) === resolve(right)) return true;
  try { return await realpath(left) === await realpath(right); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

function metadataSelection(manager, models, options) {
  const saved = manager.buildSessionContext();
  if (saved.messages.length) return {};
  const restored = {};
  // The native SDK ignores saved selection when a branch has no messages, then
  // appends its defaults. Pin the native metadata before that can rewrite it.
  if (!options.model && saved.model) {
    const model = models.getModel(saved.model.provider, saved.model.modelId);
    if (!model || !models.hasConfiguredAuth(model.provider)) throw new Error(modelRestoreFailure);
    restored.model = model;
  }
  if (options.thinkingLevel === undefined && manager.getBranch().some(entry => entry.type === 'thinking_level_change'))
    restored.thinkingLevel = saved.thinkingLevel;
  return restored;
}

// The SDK diagnoses collisions before extensionsOverride. Remove only the exact
// diagnostic for a verified duplicate of this file; unknown errors stay fatal.
function duplicateDiagnostic(error, own, duplicates) {
  for (const duplicate of duplicates) {
    for (const [kind, field] of [['Tool', 'tools'], ['Flag', 'flags']]) {
      for (const name of own[field].keys()) {
        if (!duplicate[field].has(name)) continue;
        if (error.path === own.path && error.error === `${kind} "${name}" conflicts with ${duplicate.path}`) return true;
        if (error.path === duplicate.path && error.error === `${kind} "${name}" conflicts with ${own.path}`) return true;
      }
    }
  }
  return false;
}

/** Assemble an SDK host; nothing registers or activates a worker implicitly. */
export async function createContinuationRuntime(sdk, { cwd, sessionManager, agentDir = sdk.getAgentDir(),
  initialTrustContext, modelRuntime, resourceLoaderOptions = {}, sessionOptions = {},
  bindings = {}, report = () => {} } = {}) {
  for (const name of ['createAgentSessionServices', 'createAgentSessionFromServices',
    'createAgentSessionRuntime', 'createCodemodeExtension', 'createToolSearchExtension', 'createMcpExtension']) {
    if (typeof sdk[name] !== 'function') throw new Error(`Pi SDK capability required: ${name}`);
  }
  // Native builtin factories use the process configuration directory. Do not
  // advertise an isolated services root while MCP reads another root's state.
  const nativeAgentDir = sdk.getAgentDir();
  if (!await sameDirectory(agentDir, nativeAgentDir))
    throw new Error('SDK host agentDir must match the native process configuration directory');
  agentDir = nativeAgentDir;
  const promptScope = createPromptScope();
  const trustDiagnostics = [];
  const resolveTrust = createProjectTrustResolver(sdk, agentDir, (operation, error, context) => {
    report(operation, error, context);
    trustDiagnostics.push({ type: 'warning',
      message: 'Continuation project trust hook failed; no trust was inferred from its error.' });
  });
  let initial = true;
  let worker;

  const extension = pi => {
    worker = bindObservation(pi, { ...bindings, promptScope, launchGuard: () => true });
    bindSupervisor(pi, bindings);
    bindCoordinator(pi, bindings);
  };
  const factories = [
    { name: 'codemode', factory: sdk.createCodemodeExtension(), replaceable: true, builtin: true },
    { name: 'tool-search', factory: sdk.createToolSearchExtension(), replaceable: true, builtin: true },
    { name: 'mcp', factory: sdk.createMcpExtension(), replaceable: true, builtin: true },
    // This CLI builtin has no public SDK factory. Never reinterpret its command
    // as a user/model prompt; a configured extension can replace this fallback.
    { name: 'unavailable-llama-command', replaceable: true, factory(pi) {
      pi.registerCommand('llama', { description: 'Local-model management is unavailable in this SDK host',
        handler: async (_args, ctx) => ctx.ui.notify(
          'The native llama.cpp CLI extension is not included in this SDK host. No model message was sent.', 'warning') });
    } },
    { name: 'pi-continuation-runtime', factory: extension },
    ...(resourceLoaderOptions.extensionFactories ?? []),
  ];
  const resources = base => {
    const selected = resourceLoaderOptions.extensionsOverride ?
      resourceLoaderOptions.extensionsOverride(base) : base;
    const own = selected.extensions.filter(item => item.path === runtimeExtension);
    if (own.length !== 1) throw new Error('Continuation runtime extension must load exactly once');
    const duplicates = selected.extensions.filter(item => item !== own[0] &&
      resolve(item.resolvedPath) === extensionFile);
    const others = selected.extensions.filter(item => item !== own[0] && !duplicates.includes(item));
    for (const other of others) {
      for (const field of ['commands', 'tools', 'flags']) {
        for (const name of own[0][field].keys()) {
          if (other[field].has(name)) throw new Error('Continuation name is registered by another extension');
        }
      }
    }
    return promptScope.resources({ ...selected, extensions: [own[0], ...others],
      errors: selected.errors.filter(error => !duplicateDiagnostic(error, own[0], duplicates)) });
  };

  const createRuntime = async options => {
    const first = initial;
    initial = false;
    // SDK defaults trust project configuration. Match the native trust boundary
    // instead: only global resources may load before the resolver decides.
    const settingsManager = sdk.SettingsManager.create(options.cwd, agentDir, { projectTrusted: false });
    const sourceContext = options.projectTrustContext ?? (first ? initialTrustContext : undefined);
    const context = sourceContext ? { ...sourceContext, cwd: options.cwd,
      ui: promptScope.observeUI(sourceContext.ui) } : {
      cwd: options.cwd, mode: 'tui', hasUI: false,
      ui: { select: async () => undefined, confirm: async () => false,
        input: async () => undefined, notify() {} },
    };
    const services = await sdk.createAgentSessionServices({
      cwd: options.cwd, agentDir, settingsManager, ...(modelRuntime ? { modelRuntime } : {}),
      resourceLoaderOptions: { ...resourceLoaderOptions,
        extensionFactories: factories, extensionsOverride: resources },
      resourceLoaderReloadOptions: {
        resolveProjectTrust: ({ extensionsResult }) => resolveTrust({ cwd: options.cwd,
          settingsManager, extensionsResult, context }),
      },
    });
    let result;
    try {
      const { errors } = services.resourceLoader.getExtensions();
      if (errors.length) throw new Error('Continuation runtime resources failed to load', { cause: errors });
      // Native /login bypasses ExtensionContext.ui, including its pending prompts.
      promptScope.observeModelAuth(services.modelRuntime);
      const selection = metadataSelection(options.sessionManager, services.modelRuntime, sessionOptions);
      result = await sdk.createAgentSessionFromServices({ ...sessionOptions, ...selection, services,
        sessionManager: options.sessionManager, sessionStartEvent: options.sessionStartEvent });
      if (result.modelFallbackMessage) throw new Error(modelRestoreFailure);
    } catch (error) {
      result?.session.dispose();
      await services.modelRuntime.settleCredentialWrites();
      throw error;
    }
    return { ...result, services,
      diagnostics: [...services.diagnostics, ...trustDiagnostics.splice(0)] };
  };

  const runtime = await sdk.createAgentSessionRuntime(createRuntime,
    { cwd, agentDir, sessionManager });
  return { runtime, promptScope, get worker() { return worker; } };
}
