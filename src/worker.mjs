#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { realpath, stat } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createContinuationRuntime } from './runtime.mjs';
import { diagnostics } from './diagnostics.mjs';

const usage = `pi-continuation-worker [--session existing.jsonl | --continue]

Experimental: not accepted for real-worker reliance.
Start an unregistered, inactive Pi SDK worker host with shared prompt observation.
Uses native settings/resources and the saved session's working directory and model.
No worker registration, activation, ownership transfer or migration is automatic.
This is not a replacement for Pi's package/configuration CLI commands.
`;

export function workerArgs(args) {
  const result = { recent: false, help: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--help' || args[i] === '-h') result.help = true;
    else if (args[i] === '--continue') result.recent = true;
    else if (args[i] === '--session' && args[i + 1] && !args[i + 1].startsWith('-') && !result.session)
      result.session = args[++i];
    else throw new Error('Usage: pi-continuation-worker [--session existing.jsonl | --continue]');
  }
  if (result.recent && result.session) throw new Error('Choose one session selection method');
  return result;
}

function startupTrustContext(cwd) {
  const input = async title => {
    const reader = createInterface({ input: process.stdin, output: process.stdout });
    try { return await reader.question(`${title}\n> `); }
    finally { reader.close(); }
  };
  const select = async (title, options) => {
    const answer = await input(`${title}\n${options.map((option, i) => `${i + 1}. ${option}`).join('\n')}\nNumber (empty cancels):`);
    if (!/^[1-9]\d*$/.test(answer.trim())) return undefined;
    return options[Number(answer.trim()) - 1];
  };
  return { cwd, mode: 'tui', hasUI: !!process.stdin.isTTY && !!process.stdout.isTTY,
    ui: { input, select,
      confirm: async (title, message) => await select(`${title}\n${message}`, ['No', 'Yes']) === 'Yes',
      notify: message => process.stderr.write(`${message}\n`) } };
}

/** Explicit process launch only. Importing this module never starts a host. */
export async function runWorker(args, { sdk, terminal, initialTrustContext } = {}) {
  const parsed = workerArgs(args);
  if (parsed.help) { process.stdout.write(usage); return; }
  if (!terminal && (!process.stdin.isTTY || !process.stdout.isTTY))
    throw new Error('Worker host requires an interactive terminal');
  // Resolve an explicit existing file before touching configured credentials or resources.
  const sessionFile = parsed.session ? await realpath(parsed.session) : undefined;
  if (sessionFile) {
    const info = await stat(sessionFile);
    if (!info.isFile() || info.size === 0) throw new Error('Explicit session must be a non-empty saved session file');
  }
  sdk ??= await import('@earendil-works/pi-coding-agent');
  const cwd = process.cwd();
  const manager = sessionFile ? sdk.SessionManager.open(sessionFile) : parsed.recent ?
    sdk.SessionManager.continueRecent(cwd) : sdk.SessionManager.create(cwd);
  const target = manager.getCwd();
  if (!(await stat(target)).isDirectory()) throw new Error('Saved session working directory must be a directory');
  const report = diagnostics('startup');
  const host = await createContinuationRuntime(sdk, { cwd: target, sessionManager: manager,
    initialTrustContext: initialTrustContext ?? startupTrustContext(target), report });
  let mode;
  try {
    mode = new sdk.InteractiveMode(host.runtime, { terminal,
      startupDiagnostics: host.runtime.diagnostics });
    await mode.run();
  } finally {
    try { mode?.stop(); }
    finally { await host.runtime.dispose(); }
  }
}

let direct = false;
try { direct = realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); }
catch { /* Imported by a host without a file entry point. */ }
if (direct) {
  try { await runWorker(process.argv.slice(2)); }
  catch (error) {
    const report = diagnostics('startup');
    process.stderr.write(`${report('start worker', error).message}\n`);
    process.exitCode = 1;
  }
}
