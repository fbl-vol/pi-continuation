import assert from 'node:assert/strict';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bindContinuation } from '../../src/ordinary.mjs';
import { endpoint } from '../../src/herdr.mjs';
import { readJson } from '../../src/store.mjs';

export async function startFixture(t, { blank = false } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'continuation-start-')));
  const socketPath = process.platform === 'win32' ? `test-${randomUUID()}` : join(root, 'herdr.sock');
  const sockets = new Set();
  const agents = [];
  const herdr = net.createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.once('data', data => {
      const request = JSON.parse(data.toString());
      socket.write(JSON.stringify({ id: request.id, result: request.method === 'events.subscribe' ?
        { type: 'subscription_started' } : { type: 'session_snapshot', snapshot: { protocol: 22, agents } } }) + '\n');
    });
  });
  function native(paneId) {
    const id = randomUUID(), file = join(root, `${id}.jsonl`);
    const handlers = new Map(), commands = new Map(), tools = new Map(), input = new Set();
    const entries = [], messages = [], notifications = [], confirmations = [];
    let leaf = 'initial', confirm = true;
    const ctx = { mode: 'tui', cwd: root, isIdle: () => true,
      sessionManager: { getSessionId: () => id, getSessionFile: () => file,
        getLeafId: () => leaf, getBranch: () => entries,
        buildSessionProjection: () => ({ messages: entries.filter(e => e.type === 'message').map(e => e.message) }) },
      ui: { confirm: async (...args) => { confirmations.push(args); return confirm; },
        select: async () => undefined, input: async () => undefined, editor: async () => undefined,
        custom: async () => undefined, onTerminalInput: fn => { input.add(fn); return () => input.delete(fn); },
        notify: (...args) => notifications.push(args) } };
    const append = entry => { leaf = randomUUID(); entries.push({ id: leaf, ...entry }); };
    const pi = { on: (name, fn) => handlers.set(name, [...(handlers.get(name) ?? []), fn]),
      registerCommand: (name, command) => commands.set(name, command.handler),
      registerTool: tool => tools.set(tool.name, tool.execute),
      appendEntry: (customType, data) => append({ type: 'custom', customType, data }),
      sendMessage: (...args) => messages.push(args),
      sendUserMessage: () => assert.fail('Start enrollment must not send another task') };
    bindContinuation(pi, { root, socketPath, paneId });
    return { pi, ctx, id, file, entries, messages, notifications, confirmations,
      confirm: value => { confirm = value; },
      raw: data => { for (const fn of input) fn(data); },
      user: text => append({ type: 'message', message: { role: 'user', content: text } }),
      assistant: (text, stopReason = 'stop') => append({ type: 'message',
        message: { role: 'assistant', stopReason, content: [{ type: 'text', text }] } }),
      command: (name, argument) => commands.get(name)(argument, ctx),
      emit: async (name, event = {}) => { for (const fn of handlers.get(name) ?? []) await fn(event, ctx); },
      dispose: args => tools.get('continuation_disposition')('call', args, undefined, undefined, ctx) };
  }
  const worker = native('w:p1'), supervisor = native('s:p1');
  agents.push({ agent: 'pi', pane_id: 'w:p1', terminal_id: 'terminal', cwd: root,
    workspace_id: 'w', tab_id: 'w:t1', agent_status: 'idle', completion_seq: 1, state_change_seq: 1,
    agent_session: { source: 'herdr:pi', agent: 'pi', kind: 'path', value: worker.file } });
  const prior = process.env.HERDR_ENV;
  process.env.HERDR_ENV = '1';
  t.after(async () => {
    await supervisor.emit('session_shutdown');
    await worker.emit('session_shutdown');
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => herdr.close(resolve));
    if (prior === undefined) delete process.env.HERDR_ENV; else process.env.HERDR_ENV = prior;
    await rm(root, { recursive: true, force: true });
  });
  await writeFile(worker.file, '{}\n');
  await writeFile(supervisor.file, '{}\n');
  await new Promise(resolve => herdr.listen(endpoint(socketPath), resolve));
  if (!blank) {
    worker.user('Complete both approved stages, documenting concrete results before whole-task completion.');
    worker.assistant('Stage one produced the artifact. Stage two remains approved and unfinished.');
  }
  await worker.emit('session_start');
  supervisor.ctx.isIdle = () => false; // No fake model wake; tests choose dispositions explicitly.
  const supervisorCommand = argument => supervisor.command('continuation-supervisor', argument);
  const workerStart = () => worker.command('continuation-worker', 'start');
  const state = () => readJson(join(root, 'supervisor.json'));
  const workerId = () => worker.entries.find(e => e.customType === 'pi-continuation-worker')?.data.workerId;
  const observation = () => readJson(join(root, `observation-${workerId()}.json`));
  return { root, agents, worker, supervisor, supervisorCommand, workerStart, state, workerId, observation };
}
