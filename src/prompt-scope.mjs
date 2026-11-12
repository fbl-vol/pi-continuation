import { randomUUID } from 'node:crypto';

const promptMethods = ['select', 'confirm', 'input', 'editor', 'custom'];

/** Host-lifetime observation of SDK prompt contexts and native interactive auth. */
export function createPromptScope() {
  const id = randomUUID();
  const listeners = new Set();
  const contexts = new WeakMap();
  const authModels = new WeakSet();
  const authHooks = new Set();
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
  const checkAuthHooks = () => {
    for (const hook of authHooks) {
      const models = hook.models.deref();
      if (!models) { authHooks.delete(hook); continue; }
      const wrapped = hook.login.deref();
      if (!invalidated && (!wrapped || models.login !== wrapped)) {
        // Restoring a hook cannot disprove missed auth during the gap.
        invalidated = true;
        signal();
      }
    }
  };
  const observeModelAuth = models => {
    if (authModels.has(models)) { checkAuthHooks(); return models; }
    const original = models?.login;
    if (typeof original !== 'function') throw new Error('Unsupported model auth surface');
    const wrapped = function (...args) { return track(() => original.apply(this, args)); };
    models.login = wrapped;
    if (models.login !== wrapped) throw new Error('Model auth surface is not writable');
    authModels.add(models);
    // Both references must be weak: a bound method can retain its runtime.
    authHooks.add({ models: new WeakRef(models), login: new WeakRef(wrapped) });
    return models;
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
    return ui;
  };

  return {
    get active() { checkAuthHooks(); return invalidated || active > 0; },
    snapshot() { checkAuthHooks(); return { id, revision }; },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    observeUI,
    observeModelAuth,
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
