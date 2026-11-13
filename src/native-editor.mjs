function diagnosticCommand(text) {
  const command = typeof text === 'string' ? text.trim() : '';
  return command === '/share' || command === '/bug' || command.startsWith('/bug ');
}

function submissionDescriptor(editor) {
  for (let owner = editor; owner; owner = Object.getPrototypeOf(owner)) {
    const descriptor = Object.getOwnPropertyDescriptor(owner, 'onSubmit');
    if (descriptor) return { owner, descriptor };
  }
}

/** Observe native async diagnostics through the public editor callback, not UI focus. */
export function createNativeEditorScope({ Editor, track, invalidate, observeMethod, observeAccessor }) {
  const contexts = new WeakMap();
  const factories = new WeakMap();
  const originals = new WeakMap();
  const editors = new WeakSet();
  const callbacks = new WeakSet();
  const defaults = new WeakMap();

  const wrapCallback = callback => {
    if (typeof callback !== 'function' || callbacks.has(callback)) return callback;
    const wrapped = function (...args) {
      if (!diagnosticCommand(args[0])) return callback.apply(this, args);
      return track(() => {
        const result = callback.apply(this, args);
        // 1.5.2 returns the complete Core flow Promise here, despite the void
        // callback type. Detached/unknown behavior cannot establish completion.
        if (!result || typeof result.then !== 'function') invalidate();
        return result;
      });
    };
    callbacks.add(wrapped);
    return wrapped;
  };
  const wrapEditor = editor => {
    if (editors.has(editor)) return editor;
    if (!editor || typeof editor !== 'object') throw new Error('Unsupported native editor component');
    const property = submissionDescriptor(editor);
    if (property && (!('value' in property.descriptor) || !property.descriptor.writable ||
      (property.owner === editor && !property.descriptor.configurable)))
      throw new Error('Native editor observation requires a configurable data onSubmit slot');

    let callback = wrapCallback(editor.onSubmit);
    observeAccessor(editor, 'onSubmit', {
      enumerable: property?.descriptor.enumerable ?? true,
      get() { return callback; },
      set(value) { callback = wrapCallback(value); },
    });
    editors.add(editor);
    return editor;
  };
  const wrapFactory = factory => {
    if (originals.has(factory)) return factory;
    if (factory === undefined) return defaultFactory;
    if (typeof factory !== 'function') throw new Error('Unsupported native editor factory');
    if (!factories.has(factory)) {
      const wrapped = function (...args) { return wrapEditor(factory.apply(this, args)); };
      factories.set(factory, wrapped);
      originals.set(wrapped, factory);
    }
    return factories.get(factory);
  };
  // Match the native default's embedded working indicator and retain its history
  // when a custom editor restores the default. Native setters copy appearance.
  const defaultFactory = (tui, theme, keys) => {
    if (!defaults.has(tui)) defaults.set(tui, wrapEditor(new Editor(tui, theme, keys, { embedWorkingStatus: true })));
    return defaults.get(tui);
  };
  originals.set(defaultFactory, undefined);

  const observeUI = ui => {
    if (contexts.has(ui) || (!('getEditorComponent' in ui) && !('setEditorComponent' in ui))) return;
    try {
      const get = ui.getEditorComponent, set = ui.setEditorComponent;
      if (typeof get !== 'function' || typeof set !== 'function') throw new Error('Unsupported native editor UI');
      observeMethod(ui, 'getEditorComponent', function (...args) {
        const factory = get.apply(this, args);
        return originals.has(factory) ? originals.get(factory) : factory;
      });
      observeMethod(ui, 'setEditorComponent', function (factory) {
        try { return set.call(this, wrapFactory(factory)); }
        catch (error) { invalidate(); throw error; }
      });
      contexts.set(ui, { get });
    } catch (error) { invalidate(); throw error; }
  };

  return { observeUI, install(ui) {
    observeUI(ui);
    const binding = contexts.get(ui);
    if (!binding) { invalidate(); throw new Error('Native editor UI is unavailable'); }
    if (!originals.has(binding.get.call(ui))) ui.setEditorComponent(ui.getEditorComponent());
  } };
}
