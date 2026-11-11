import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { observe } from '../src/subscription.mjs';
import { endpoint } from '../src/herdr.mjs';

test('events_lost invalidates subscription instead of replaying a partial history', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'continuation-'));
  const socketPath = process.platform === 'win32' ? `test-${randomUUID()}` : join(directory, 'herdr.sock');
  const server = net.createServer(socket => socket.once('data', data => {
    const req = JSON.parse(data.toString());
    if (req.method === 'events.subscribe') {
      socket.write(JSON.stringify({ id: req.id, result: { type: 'subscription_started' } }) + '\n');
      socket.write(JSON.stringify({ id: req.id, error: { code: 'events_lost' } }) + '\n');
    } else socket.write(JSON.stringify({ id: req.id, result: { type: 'session_snapshot',
      snapshot: { protocol: 22, agents: [] } } }) + '\n');
  }));
  try {
    await new Promise(resolve => server.listen(endpoint(socketPath), resolve));
    const error = await new Promise(resolve => {
      const close = observe(socketPath, () => {}, resolve);
      close.ready.catch(resolve);
    });
    assert.match(error.message, /events_lost/);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test('subscribe before snapshot; overlapping events cause another authoritative read', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'continuation-'));
  const socketPath = process.platform === 'win32' ? `test-${randomUUID()}` : join(directory, 'herdr.sock');
  let subscription;
  let reads = 0;
  const server = net.createServer(socket => socket.once('data', chunk => {
    const req = JSON.parse(chunk.toString());
    if (req.method === 'events.subscribe') {
      subscription = socket;
      assert.ok(req.params.subscriptions.some(s => s.type === 'pane.agent_status_changed'));
      socket.write(JSON.stringify({ id: req.id, result: { type: 'subscription_started' } }) + '\n');
    } else {
      assert.equal(req.method, 'session.snapshot');
      reads++;
      if (reads === 1) subscription.write(JSON.stringify({ event: 'pane.agent_status_changed', data: {} }) + '\n');
      socket.write(JSON.stringify({ id: req.id, result: { type: 'session_snapshot',
        snapshot: { protocol: 22, agents: [{ pane_id: `p${reads}` }] } } }) + '\n');
    }
  }));
  try {
    await new Promise(resolve => server.listen(endpoint(socketPath), resolve));
    const seen = [];
    let close;
    await new Promise((resolve, reject) => {
      close = observe(socketPath, state => {
        seen.push(state.agents[0].pane_id);
        if (seen.length === 2) resolve();
      }, reject);
    });
    close();
    assert.deepEqual(seen, ['p1', 'p2']);
  } finally {
    subscription?.destroy();
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
