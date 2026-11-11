const codes = new Set(['ENOENT', 'EACCES', 'EPERM', 'ENOSPC', 'EIO', 'EISDIR',
  'ENOTDIR', 'EEXIST', 'ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'EADDRINUSE',
  'IPC_TIMEOUT', 'IPC_CLOSED', 'IPC_FRAME', 'INVALID_RECORD', 'UNSUPPORTED_FORMAT']);

// One terminal owner reports a failure. Never render raw paths, payloads or messages.
// The original cause remains in memory for inspection, not in persisted/model output.
export function diagnostics(role) {
  const report = (operation, error, ctx) => {
    const code = codes.has(error?.code) ? error.code :
      error instanceof SyntaxError ? 'INVALID_JSON' : 'UNEXPECTED';
    report.last = { role, operation, code };
    report.cause = error;
    const message = `Continuation ${role}: ${operation} failed (${code}); inspect before retrying.`;
    try { ctx?.ui?.notify(message, 'error'); }
    catch { /* Diagnostic UI failure must not change delivery or cleanup semantics. */ }
    report.lastError = Object.assign(new Error(message), { code });
    return report.lastError;
  };
  return report;
}
