import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const directory = mkdtempSync(join(tmpdir(), 'continuation-pack-'));
try {
  const [packed] = JSON.parse(execFileSync('npm', ['pack', '--json', '--pack-destination', directory],
    { encoding: 'utf8', shell: process.platform === 'win32' }));
  const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
  const expected = [...manifest.files.filter(name => !name.endsWith('/')),
    'package.json'].sort();
  const actual = packed.files.map(file => file.path).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Unexpected npm payload: ${JSON.stringify(actual)}`);
  }
  if (!manifest.private || manifest.pi.extensions.length !== 1 ||
      !actual.includes(manifest.pi.extensions[0].replace(/^\.\//, ''))) {
    throw new Error('Private guard or explicit extension entrypoint missing');
  }
  if (!existsSync(join(directory, packed.filename))) throw new Error('Package tarball missing');
  console.log(`Packed ${packed.filename}: ${actual.length} explicit files (private)`);
} finally { rmSync(directory, { recursive: true, force: true }); }
