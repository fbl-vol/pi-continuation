import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { endpoint, snapshot } from './herdr.mjs';

// Subscribe before the first read. Events only invalidate a snapshot, never replay onto it.
export function observe(socketPath, onSnapshot, onDisconnect) {
  const id = randomUUID();
  const socket = net.createConnection(endpoint(socketPath));
  let buffer = '';
  let started = false;
  let reading = false;
  let dirty = false;
  let closed = false;
  let notified = false;
  let readyResolve, readyReject;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const timer = setTimeout(() => disconnect(new Error('Herdr subscription startup timed out')), 2500);
  const disconnect = error => {
    if (closed || notified) return;
    notified = true;
    clearTimeout(timer);
    if (!started) readyReject(error);
    socket.destroy();
    onDisconnect(error);
  };
  const refresh = async () => {
    dirty = true;
    if (reading || !started) return;
    reading = true;
    try {
      while (dirty && !closed && !notified) {
        dirty = false;
        const state = await snapshot(socketPath);
        if (!closed && !notified) await onSnapshot(state);
      }
    } catch (error) { disconnect(error); }
    finally { reading = false; }
  };
  socket.on('connect', () => socket.write(JSON.stringify({ id, method: 'events.subscribe', params: {
    subscriptions: [{ type: 'pane.agent_status_changed' }, { type: 'pane.updated' },
      { type: 'pane.agent_detected' }, { type: 'pane.closed' }, { type: 'pane.exited' }, { type: 'workspace.closed' }],
  } }) + '\n'));
  socket.on('data', chunk => {
    buffer += chunk.toString('utf8');
    if (buffer.length > 2_000_000) return disconnect(new Error('Herdr event buffer too large'));
    for (let end; (end = buffer.indexOf('\n')) >= 0;) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      try {
        const message = JSON.parse(line);
        if (message.id === id && message.error) throw new Error(`Herdr subscription: ${message.error.code}`);
        if (!started) {
          if (message.id !== id || message.result?.type !== 'subscription_started')
            throw new Error('Unexpected Herdr subscription start');
          started = true;
          clearTimeout(timer);
          readyResolve();
        }
        void refresh();
      } catch (error) { disconnect(error); return; }
    }
  });
  socket.on('error', disconnect);
  socket.on('end', () => disconnect(new Error('Herdr subscription ended')));
  const close = () => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    if (!started) readyReject(new Error('Herdr subscription closed before start'));
    socket.destroy();
  };
  close.ready = ready;
  return close;
}
