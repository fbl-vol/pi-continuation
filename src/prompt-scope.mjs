import { randomUUID } from 'node:crypto';

const promptMethods = new Set(['select', 'confirm', 'input', 'editor', 'custom']);

/** Host-lifetime observation for UI contexts supplied through SDK resource loading. */
export function createPromptScope() {
  const id = randomUUID();
  const listeners = new Set();
  const contexts = new WeakMap();
  let revision = 0;
  let active = 0;

  const observeUI = ui => {
    if (contexts.has(ui)) return contexts.get(ui);
    const methods = new Map();
    const proxy = new Proxy(ui, {
      get(target, name, receiver) {
        if (!promptMethods.has(name)) return Reflect.get(target, name, receiver);
        const original = Reflect.get(target, name, target);
        if (typeof original !== 'function') throw new Error('Unsupported prompt UI surface');
        if (methods.get(name)?.original !== original) {
          const wrapped = (...args) => {
            active++;
            revision++;
            try {
              for (const listener of listeners) listener();
              return Promise.resolve(original.apply(target, args)).finally(() => { active--; });
            } catch (error) { active--; throw error; }
          };
          methods.set(name, { original, wrapped });
        }
        return methods.get(name).wrapped;
      },
    });
    contexts.set(ui, proxy);
    return proxy;
  };

  return {
    get active() { return active > 0; },
    snapshot: () => ({ id, revision }),
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
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
