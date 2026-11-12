/** Resolve SDK project loading before executable project resources are discovered. */
export function createProjectTrustResolver(sdk, agentDir, report = () => {}) {
  const store = new sdk.ProjectTrustStore(agentDir);
  const sessionDecisions = new Map();

  return async ({ cwd, settingsManager, extensionsResult, context }) => {
    if (!sdk.hasTrustRequiringProjectResources(cwd)) return store.get(cwd) ?? true;

    // The SDK exposes pre-trust extension definitions and the project_trust
    // contract, but not the CLI's dispatcher. Global handlers retain priority.
    const handlers = extensionsResult.extensions.flatMap(extension =>
      [...(extension.handlers.get('project_trust') ?? [])]);
    for (const handler of handlers) {
      let result;
      try { result = await handler({ type: 'project_trust', cwd }, context); }
      catch (error) { report('project trust handler failed', error, context); continue; }
      if (!result || result.trusted === 'undecided') continue;
      if (result.trusted !== 'yes' && result.trusted !== 'no') {
        report('project trust handler returned an invalid decision', undefined, context);
        continue;
      }
      const trusted = result.trusted === 'yes';
      if (result.remember === true) store.set(cwd, trusted);
      sessionDecisions.set(cwd, trusted);
      return trusted;
    }

    // Explicit native settings/store updates outrank a session-only decision.
    const saved = store.get(cwd);
    if (saved !== null) return saved;
    const defaultTrust = settingsManager.getDefaultProjectTrust();
    if (defaultTrust === 'always') return true;
    if (defaultTrust === 'never') return false;
    if (sessionDecisions.has(cwd)) return sessionDecisions.get(cwd);
    if (!context.hasUI) return false;

    const once = 'Trust for this process only';
    const remember = 'Trust this folder and remember';
    const deny = 'Do not trust project resources';
    const selected = await context.ui.select(
      `Trust project folder?\n${cwd}\nAllows project settings, packages and executable extensions.`,
      [once, remember, deny]);
    const trusted = selected === once || selected === remember;
    if (selected === remember) store.set(cwd, true);
    sessionDecisions.set(cwd, trusted);
    return trusted;
  };
}
