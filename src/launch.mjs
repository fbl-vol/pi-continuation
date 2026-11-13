import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';

// Pi loads explicit -e extensions ahead of discovered packages, in CLI order.
// Require the guard as the first *option*, not the first matching raw argv:
// another option may consume "-e" as its value without Pi loading this file.
export async function firstExtensionIs(extensionFile, argv = process.argv) {
  if (argv[2] !== '-e' && argv[2] !== '--extension') return false;
  const source = argv[3];
  if (!source || source.startsWith('builtin:')) return false;
  try { return await realpath(resolve(source)) === await realpath(extensionFile); }
  catch { return false; }
}
