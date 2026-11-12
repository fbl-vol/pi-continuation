import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bindContinuation } from '../src/ordinary.mjs';
import { endpoint } from '../src/herdr.mjs';
import { readJson } from '../src/store.mjs';

// Real role composition, registration, owner/worker sockets, records and receipts.
// Only native Pi/Herdr and the model's chosen disposition are fake, not eligibility.
for (const recovery of [false, true]) test(recovery ?
  'P3/P4/P7 ordinary human Clear allows same-report review, not activation, then one-use continuation' :
  'P1/P2 ordinary idle enrollment reaches addressed continuation once, without a launcher or new task',
  { timeout: 10000 }, async t => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'continuation-flow-')));
    const socketPath = process.platform === 'win32' ? `test-${randomUUID()}` : join(root, 'herdr.sock');
    const sessionId = randomUUID();
    const sessionFile = join(root, 'worker.jsonl');
    const checkpoint = join(root, 'checkpoint.md');
    const evidence = 'Continue the remaining already-approved implementation step.';
    await writeFile(sessionFile, '{}\n');
    await writeFile(checkpoint, evidence);
    const agent = { agent: 'pi', pane_id: 'w:p1', terminal_id: 'worker-terminal', cwd: root,
      workspace_id: 'w', tab_id: 'w:t1', agent_status: 'idle', completion_seq: 1, state_change_seq: 1,
      agent_session: { source: 'herdr:pi', agent: 'pi', kind: 'path', value: sessionFile } };
    const sockets = new Set();
    const herdr = net.createServer(socket => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      socket.once('data', data => {
        const request = JSON.parse(data.toString());
        socket.write(JSON.stringify({ id: request.id, result: request.method === 'events.subscribe' ?
          { type: 'subscription_started' } : { type: 'session_snapshot',
            snapshot: { protocol: 22, agents: [agent] } } }) + '\n');
      });
    });
    function native(id, file, paneId) {
      const handlers = new Map(), commands = new Map(), tools = new Map(), entries = [], messages = [], input = new Set();
      let leaf = 'initial-leaf';
      const ctx = { mode: 'tui', cwd: root, isIdle: () => true,
        sessionManager: { getSessionId: () => id, getSessionFile: () => file,
          getLeafId: () => leaf, getBranch: () => entries },
        ui: { confirm: async () => true, select: async () => undefined, input: async () => undefined,
          editor: async () => undefined, custom: async () => undefined,
          onTerminalInput: fn => { input.add(fn); return () => input.delete(fn); }, notify: () => {} } };
      const pi = { on: (name, fn) => handlers.set(name, [...(handlers.get(name) ?? []), fn]),
        registerCommand: (name, command) => commands.set(name, command.handler),
        registerTool: tool => tools.set(tool.name, tool.execute),
        appendEntry: (customType, data) => { leaf = randomUUID(); entries.push({ id: leaf, type: 'custom', customType, data }); },
        sendMessage: (...args) => messages.push(args),
        sendUserMessage: () => assert.fail('Plain enrollment must not send another task') };
      bindContinuation(pi, { root, socketPath, paneId });
      return { pi, ctx, entries, messages, commands, tools,
        rawInput: () => { for (const fn of input) fn({ data: '/continuation-worker-clear-hold\r' }); },
        assistant: text => { leaf = randomUUID(); entries.push({ id: leaf, type: 'message',
          message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text }] } }); },
        emit: async (name, event = {}) => {
          for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
        } };
    }
    const worker = native(sessionId, sessionFile, agent.pane_id);
    worker.entries.push({ id: 'report', type: 'message', message: { role: 'assistant', stopReason: 'stop',
      content: [{ type: 'text', text: 'Approved work remains; use the existing checkpoint.' }] } });
    const supervisor = native(randomUUID(), join(root, 'supervisor.jsonl'), 's:p1');
    const previous = process.env.HERDR_ENV;
    process.env.HERDR_ENV = '1';
    t.after(async () => {
      await supervisor.emit('session_shutdown');
      await worker.emit('session_shutdown');
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve => herdr.close(resolve));
      if (previous === undefined) delete process.env.HERDR_ENV;
      else process.env.HERDR_ENV = previous;
      await rm(root, { recursive: true, force: true });
    });
    await new Promise(resolve => herdr.listen(endpoint(socketPath), resolve));
    await worker.emit('session_start');
    await worker.commands.get('continuation-worker')(checkpoint, worker.ctx);
    const workerId = worker.entries.find(entry => entry.customType === 'pi-continuation-worker').data.workerId;
    if (recovery) {
      worker.rawInput();
      await worker.emit('input', { source: 'interactive', text: 'Continue the approved assignment' });
      await worker.emit('agent_start');
      worker.assistant('Approved work remains; use the existing checkpoint.');
      await worker.emit('agent_settled');
      const held = await readJson(join(root, `observation-${workerId}.json`));
      assert.equal(held.outcome, 'approval');
      assert.equal(held.hold, true);
      // Native command dispatch precedes Pi's input event. Raw terminal keys still occur.
      worker.rawInput();
      await worker.commands.get('continuation-worker-clear-hold')('', worker.ctx);
      const cleared = await readJson(join(root, `observation-${workerId}.json`));
      assert.equal(cleared.stop, held.stop);
      assert.equal(cleared.finalReply, held.finalReply);
      assert.equal(cleared.hold, false);
    }
    const observation = await readJson(join(root, `observation-${workerId}.json`));
    assert.equal(observation.outcome, 'completed');
    assert.equal(worker.messages.length, 0);
    supervisor.ctx.isIdle = () => false;
    const command = args => supervisor.commands.get('continuation-supervisor')(args, supervisor.ctx);
    await command('init');
    await command(`add ${workerId} w`);
    let state = await readJson(join(root, 'supervisor.json'));
    assert.equal(state.paused, true);
    assert.equal(state.routes.w.paused, true);
    assert.equal(state.workers[workerId].paused, true);
    const dispose = () => supervisor.tools.get('continuation_disposition')('call',
      { workerId, stop: observation.stop, action: 'resume', evidence }, undefined, undefined, supervisor.ctx);
    if (recovery) {
      assert.match((await dispose()).content[0].text, /Paused/);
      assert.equal(worker.messages.length, 0);
      assert.deepEqual(state.budgets, {});
    }
    await command(`activate worker ${workerId}`);
    await command('activate route w');
    await command('activate global');
    let awaken;
    const attention = new Promise(resolve => { awaken = resolve; });
    supervisor.pi.sendMessage = (message, options) => { supervisor.messages.push([message, options]); awaken(message); };
    supervisor.ctx.isIdle = () => true;
    await supervisor.emit('session_start');
    const message = await attention;
    assert.match(message.content, /Approved work remains/);
    assert.match(message.content, new RegExp(workerId));
    assert.match((await dispose()).content[0].text, /Continuation delivered/);
    assert.equal(worker.messages.length, 1);
    assert.equal(worker.messages[0][1].triggerTurn, true);
    assert.match((await dispose()).content[0].text, /Stale or ineligible/);
    assert.equal(worker.messages.length, 1);
    state = await readJson(join(root, 'supervisor.json'));
    assert.equal(state.resumed[workerId], observation.stop);
    assert.equal(state.budgets[workerId].count, 1);
    if (recovery) {
      // Clearing again cannot revive the report that was actually delivered.
      worker.rawInput();
      await worker.commands.get('continuation-worker-clear-hold')('', worker.ctx);
      const invalidated = await readJson(join(root, `observation-${workerId}.json`));
      assert.equal(invalidated.stop, null);
      assert.equal(invalidated.outcome, 'unknown');
      assert.match((await dispose()).content[0].text, /Stale or ineligible/);
      assert.equal(worker.messages.length, 1);
      const afterClear = await readJson(join(root, 'supervisor.json'));
      assert.equal(afterClear.resumed[workerId], observation.stop);
      assert.equal(afterClear.budgets[workerId].count, 1);
    }
  });
