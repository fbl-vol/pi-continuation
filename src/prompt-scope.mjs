import { randomUUID } from 'node:crypto';
import { createNativeEditorScope } from './native-editor.mjs';

const promptMethods = ['select', 'confirm', 'input', 'editor', 'custom'];

/** Host-lifetime observation of SDK prompt contexts and native interactive operations. */
export function createPromptScope({ Editor } = {}) {
  const id = randomUUID();
  const listeners = new Set();
  const contexts = new WeakMap();
  const authModels = new WeakSet();
  const sessionRuntimes = new WeakSet();
  const hooks = new Set();
  let revision = 0;
  let active = 0;
  let invalidated = false;

  const signal = () => {
    revision++;
    for (const listener of listeners) listener();
  };
  const track = invoke => {
    active++;
    try {
      signal();
      return Promise.resolve(invoke()).finally(() => { active--; });
    } catch (error) { active--; throw error; }
  };
  const invalidate = () => {
    // Restoring a hook cannot disprove missed UI during the gap.
    if (!invalidated) { invalidated = true; signal(); }
  };
  const checkHooks = () => {
    for (const hook of hooks) {
      const target = hook.target.deref();
      if (!target) { hooks.delete(hook); continue; }
      if (hook.method) {
        const method = hook.method.deref();
        if (!method || target[hook.name] !== method) invalidate();
      } else {
        const property = Object.getOwnPropertyDescriptor(target, hook.name);
        const get = hook.get.deref(), set = hook.set.deref();
        if (!get || !set || property?.get !== get || property?.set !== set) invalidate();
      }
    }
  };
  const observeMethod = (target, name, wrapped) => {
    checkHooks();
    target[name] = wrapped;
    if (target[name] !== wrapped) throw new Error('Observed method is not writable');
    // A bound method or callback accessor can retain its owner: all references
    // in the integrity registry must remain weak, not only the target.
    hooks.add({ target: new WeakRef(target), name, method: new WeakRef(wrapped) });
  };
  const observeAccessor = (target, name, descriptor) => {
    checkHooks();
    Object.defineProperty(target, name, { ...descriptor, configurable: true });
    hooks.add({ target: new WeakRef(target), name,
      get: new WeakRef(descriptor.get), set: new WeakRef(descriptor.set) });
  };
  const editors = Editor ? createNativeEditorScope({ Editor, track, invalidate, observeMethod, observeAccessor }) : undefined;
  const observeModelAuth = models => {
    if (authModels.has(models)) { checkHooks(); return models; }
    const original = models?.login;
    if (typeof original !== 'function') throw new Error('Unsupported model auth surface');
    const wrapped = function (...args) { return track(() => original.apply(this, args)); };
    observeMethod(models, 'login', wrapped);
    authModels.add(models);
    return models;
  };

  const observeSessionTransitions = runtime => {
    if (sessionRuntimes.has(runtime)) { checkHooks(); return runtime; }
    for (const name of ['switchSession', 'importFromJsonl']) {
      const original = runtime?.[name];
      if (typeof original !== 'function') throw new Error('Unsupported native session transition surface');
      observeMethod(runtime, name, async function (...args) {
        try { return await original.apply(this, args); }
        catch (error) {
          // The 1.5.2 frontend asks a separate, unobservable cwd question AFTER
          // this public operation rejects. Its completion cannot end that UI.
          if (error instanceof Error && Object.getOwnPropertyDescriptor(error, 'name')?.value === 'MissingSessionCwdError')
            invalidate();
          throw error;
        }
      });
    }
    sessionRuntimes.add(runtime);
    return runtime;
  };

  const observeUI = ui => {
    const known = contexts.get(ui) ?? new Map();
    // ProjectTrustContext exposes only select/confirm/input, unlike a full UI.
    const originals = new Map(promptMethods.filter(name => name in ui && !known.has(name)).map(name => {
      if (typeof ui[name] !== 'function') throw new Error('Unsupported prompt UI surface');
      return [name, ui[name]];
    }));
    const wrappers = new Map([...originals].map(([name, original]) =>
      [name, (...args) => track(() => original.apply(ui, args))]));
    try {
      for (const [name, wrapped] of wrappers) {
        ui[name] = wrapped;
        if (ui[name] !== wrapped) throw new Error('Prompt UI is not writable');
      }
    } catch (error) {
      for (const [name, wrapped] of wrappers) {
        if (ui[name] === wrapped) ui[name] = originals.get(name);
      }
      throw error;
    }
    // Keep this layer for the host lifetime. A disposed worker guard must not
    // leave cached shared contexts unobserved during or after a native reload.
    contexts.set(ui, new Map([...known, ...originals]));
    editors?.observeUI(ui);
    return ui;
  };

  return {
    get active() { checkHooks(); return invalidated || active > 0; },
    snapshot() { checkHooks(); return { id, revision }; },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    observeUI,
    observeModelAuth,
    observeSessionTransitions,
    installEditor(ui) {
      if (!editors) throw new Error('Native editor observer unavailable');
      observeUI(ui);
      editors.install(ui);
    },
    confirmOwned(ui, ...args) {
      return contexts.get(ui).get('confirm').apply(ui, args);
    },
    /** Compose with DefaultResourceLoader.extensionsOverride, including on reload. */
    resources(base) {
      return { ...base, extensions: base.extensions.map(extension => ({
        ...extension,
        shortcuts: new Map([...extension.shortcuts].map(([key, shortcut]) => [key, {
          ...shortcut,
          handler(ctx) {
            const ui = observeUI(ctx.ui);
            return shortcut.handler(new Proxy(ctx, {
              get(target, name, receiver) {
                return name === 'ui' ? ui : Reflect.get(target, name, receiver);
              },
            }));
          },
        }])),
      })) };
    },
  };
}
