const codes = new Set(['ENOENT', 'EACCES', 'EPERM', 'ENOSPC', 'EIO', 'EISDIR',
  'ENOTDIR', 'EEXIST', 'ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'EADDRINUSE',
  'IPC_TIMEOUT', 'IPC_CLOSED', 'IPC_FRAME', 'INVALID_RECORD', 'UNSUPPORTED_FORMAT',
  'OWNERSHIP_FENCE', 'WORKER_CONFLICT', 'WORKER_RETIRED', 'WORKER_LIVE', 'DELIVERY_PENDING']);

const startMessages = {
  WORKER_CONFLICT: 'Worker registration conflict changed or cannot be replaced; inspect supervisor status.',
  WORKER_RETIRED: 'This worker session was retired; it cannot be registered again.',
  WORKER_LIVE: 'The old session is still live in Herdr; replacement refused.',
  DELIVERY_PENDING: 'Old worker delivery requires inspection and resolution before replacement.',
  OWNERSHIP_FENCE: 'Worker ownership could not be verified; inspect before replacement.',
};
export const workerStartRefusal = code => startMessages[code] ??
  'Worker start not accepted; inspect supervisor status before retrying';

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
