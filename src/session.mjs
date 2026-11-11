// Pi owns identity and branching; adapters must read the current native session.
export function currentSession(ctx) {
  const id = ctx.sessionManager.getSessionId();
  const file = ctx.sessionManager.getSessionFile();
  if (!id || !file) throw new Error('A saved native Pi session is required');
  return { id, file, leaf: ctx.sessionManager.getLeafId() };
}
