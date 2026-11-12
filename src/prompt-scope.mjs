import { randomUUID } from 'node:crypto';

const promptMethods = ['select', 'confirm', 'input', 'editor', 'custom'];

/** Host-lifetime observation for UI contexts supplied through SDK resource loading. */
export function createPromptScope() {
  const id = randomUUID();
  const listeners = new Set();
  const contexts = new WeakMap();
  let revision = 0;
  let active = 0;

  const observeUI = ui => {
    const known = contexts.get(ui) ?? new Map();
    // ProjectTrustContext exposes only select/confirm/input, unlike a full UI.
    const originals = new Map(promptMethods.filter(name => name in ui && !known.has(name)).map(name => {
      if (typeof ui[name] !== 'function') throw new Error('Unsupported prompt UI surface');
      return [name, ui[name]];
    }));
    const wrappers = new Map([...originals].map(([name, original]) => [name, (...args) => {
      active++;
      revision++;
      try {
        for (const listener of listeners) listener();
        return Promise.resolve(original.apply(ui, args)).finally(() => { active--; });
      } catch (error) { active--; throw error; }
    }]));
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
    get active() { return active > 0; },
    snapshot: () => ({ id, revision }),
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    observeUI,
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
