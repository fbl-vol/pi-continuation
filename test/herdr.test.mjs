import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { endpoint, request, snapshot, sameOccupant } from '../src/herdr.mjs';

test('endpoint uses the injected native form rather than inventing a config path', () => {
  assert.equal(endpoint('session-name', 'win32'), '\\\\.\\pipe\\session-name');
  assert.equal(endpoint('/tmp/space ü/herdr.sock', 'linux'), '/tmp/space ü/herdr.sock');
  assert.throws(() => endpoint(''), /not configured/);
});

test('socket response identity, protocol and disconnect fail closed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'continuation-'));
  const socketPath = process.platform === 'win32' ? `test-${randomUUID()}` : join(directory, 'server.sock');
  const server = net.createServer(socket => {
    socket.once('data', chunk => {
      const message = JSON.parse(chunk.toString());
      socket.write(JSON.stringify({ id: message.method === 'wrong' ? 'other-id' : message.id, result: {
        type: 'session_snapshot', snapshot: { protocol: 22, agents: [] },
      } }) + '\n');
    });
  });
  try {
    await new Promise(resolve => server.listen(endpoint(socketPath), resolve));
    assert.deepEqual((await snapshot(socketPath)).agents, []);
    await assert.rejects(request(socketPath, 'wrong', {}), /id mismatch/);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test('Herdr errors retain their structured code without exposing the server message', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'continuation-'));
  const socketPath = process.platform === 'win32' ? `test-${randomUUID()}` : join(directory, 'server.sock');
  const server = net.createServer(socket => socket.once('data', chunk => {
    const { id } = JSON.parse(chunk.toString());
    socket.end(JSON.stringify({ id, error: { code: 'pane_not_found', message: 'private server detail' } }) + '\n');
  }));
  try {
    await new Promise(resolve => server.listen(endpoint(socketPath), resolve));
    await assert.rejects(request(socketPath, 'pane.report_metadata', {}), error => {
      assert.equal(error.code, 'pane_not_found');
      assert.equal(error.message, 'Herdr: pane_not_found');
      assert.equal(error.message.includes('private server detail'), false);
      return true;
    });
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test('fragmented Herdr response preserves multibyte session identity', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'continuation-'));
  const socketPath = process.platform === 'win32' ? `test-${randomUUID()}` : join(directory, 'server.sock');
  const server = net.createServer(socket => socket.once('data', chunk => {
    const { id } = JSON.parse(chunk.toString());
    const frame = Buffer.from(JSON.stringify({ id, result: { type: 'session_snapshot',
      snapshot: { protocol: 22, agents: [{ agent_session: { value: '/sessions/café.jsonl' } }] } } }) + '\n');
    const split = frame.indexOf(Buffer.from('é')) + 1;
    socket.write(frame.subarray(0, split));
    setTimeout(() => socket.end(frame.subarray(split)), 15);
  }));
  try {
    await new Promise(resolve => server.listen(endpoint(socketPath), resolve));
    assert.equal((await snapshot(socketPath)).agents[0].agent_session.value, '/sessions/café.jsonl');
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test('same name or pane is insufficient: native ref, terminal and cwd must match', () => {
  const binding = { paneId: 'w1:p1', terminalId: 'terminal-1', workspaceId: 'w1', tabId: 'w1:t1',
    cwd: '/workspace', sessionKind: 'path', sessionValue: '/sessions/a.jsonl' };
  const agent = { agent: 'pi', pane_id: 'w1:p1', terminal_id: 'terminal-1', workspace_id: 'w1',
    tab_id: 'w1:t1', cwd: '/workspace', name: 'same display name',
    agent_session: { source: 'herdr:pi', agent: 'pi', kind: 'path', value: '/sessions/a.jsonl' } };
  assert.equal(sameOccupant(agent, binding), true);
  for (const changed of [
    { terminal_id: 'replacement' }, { cwd: '/other' }, { agent_session: { ...agent.agent_session, value: '/sessions/fork.jsonl' } },
    { agent_session: { ...agent.agent_session, source: 'screen' } }, { workspace_id: 'w2' },
  ]) assert.equal(sameOccupant({ ...agent, ...changed }, binding), false);
});
