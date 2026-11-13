import * as fs from 'node:fs';
import { randomUUID } from 'node:crypto';

// A session entry and provisional records may survive failed cleanup. The
// marker is the sole commit boundary; never expose a valid marker until its
// complete contents have been synced and its handle closed.
export function commitReady(path, record, io = fs) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  let file;
  try {
    file = io.openSync(temporary, 'wx', 0o600);
    io.writeFileSync(file, JSON.stringify({ workerId: record.workerId, sessionId: record.sessionId,
      sessionFile: record.sessionFile, checkpoint: record.checkpoint }));
    io.fsyncSync(file);
    io.closeSync(file);
    file = undefined;
    if (io.existsSync(path)) throw new Error('Worker registration marker already exists');
    io.renameSync(temporary, path);
  } catch (error) {
    if (file !== undefined) { try { io.closeSync(file); } catch { /* Closed or unavailable. */ } }
    try { io.unlinkSync(temporary); } catch { /* Uncommitted temporary files are inert. */ }
    throw error;
  }
}
