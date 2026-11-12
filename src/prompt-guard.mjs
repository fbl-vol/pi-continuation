const methods = ['select', 'confirm', 'input', 'editor', 'custom'];

/**
 * Pi coalesces UI lifecycle events and emits them asynchronously. Intercept calls
 * on its shared extension UI object before display; lifecycle events remain a
 * fallback for other host contexts. This is not a prose classifier or authority.
 */
export function guardPromptUI(ui, onExternalPrompt, scope) {
  const originals = new Map();
  const wrappers = new Map();
  let external = 0;
  let own = 0;
  let revision = 0;
  let lifecycleExternal = false;
  let disposed = false;
  let invalidated = false;
  let stopScope;
  const signal = () => { revision++; onExternalPrompt(); };
  const intact = () => {
    if (disposed || invalidated) return false;
    if (methods.every(name => ui[name] === wrappers.get(name))) return true;
    // Once observation was lost, restoring the functions cannot restore consent
    // or make the caller's old stop eligible again, including after reload.
    invalidated = true;
    signal();
    return false;
  };
  const busy = () => external > 0 || own > 0 || lifecycleExternal || scope?.active === true;
  const restore = () => {
    disposed = true;
    stopScope?.();
    for (const [name, wrapped] of wrappers) {
      if (ui[name] === wrapped) ui[name] = originals.get(name);
    }
  };

  try {
    for (const name of methods) {
      if (typeof ui[name] !== 'function') throw new Error('Unsupported prompt UI surface');
      const original = ui[name];
      originals.set(name, original);
      const wrapped = (...args) => {
        if (disposed) return original.apply(ui, args);
        external++;
        signal(); // Synchronous, including when nested inside our own confirmation.
        try { return Promise.resolve(original.apply(ui, args)).finally(() => { external--; }); }
        catch (error) { external--; throw error; }
      };
      wrappers.set(name, wrapped);
      ui[name] = wrapped;
      if (ui[name] !== wrapped) throw new Error('Prompt UI is not writable');
    }
    stopScope = scope?.subscribe(signal);
  } catch (error) { restore(); throw error; }

  return {
    get intact() { return intact(); },
    get blocked() { return !intact() || busy(); },
    get revision() { return revision; },
    start() {
      // Our native confirmation is not an approval hold. A wrapped concurrent
      // call already signalled synchronously, even if Pi hides its nested span.
      if (own > 0 && external === 0) return;
      lifecycleExternal = true;
      signal();
    },
    end() { lifecycleExternal = false; },
    async confirm(...args) {
      if (!intact() || busy()) return false;
      const before = revision;
      own++;
      let accepted;
      try { accepted = await originals.get('confirm').apply(ui, args); }
      finally { own--; }
      return accepted === true && intact() && !busy() && revision === before;
    },
    dispose: restore,
  };
}
