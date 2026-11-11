import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';

// Pi loads explicit -e extensions ahead of discovered packages, in CLI order.
// Our synchronous ui_prompt_start listener must be first: a preceding handler
// can stall notification while an approval dialog is already open.
export async function firstExtensionIs(extensionFile, argv = process.argv) {
  let source;
  for (let i = 2; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--') break;
    if (flag === '-e' || flag === '--extension') { source = argv[i + 1]; break; }
    if (flag.startsWith('--extension=')) { source = flag.slice('--extension='.length); break; }
  }
  if (!source || source.startsWith('builtin:')) return false;
  try { return await realpath(resolve(source)) === await realpath(extensionFile); }
  catch { return false; }
}
