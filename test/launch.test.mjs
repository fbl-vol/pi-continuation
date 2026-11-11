import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { firstExtensionIs } from '../src/launch.mjs';

const extension = fileURLToPath(new URL('../src/extension.ts', import.meta.url));
const other = fileURLToPath(new URL('../src/observation.mjs', import.meta.url));
const cli = ['node', 'pi'];

test('only an explicit first extension matching the worker guard qualifies', async () => {
  assert.equal(await firstExtensionIs(extension, [...cli, '-e', extension, '-e', other]), true);
  assert.equal(await firstExtensionIs(extension, [...cli, '--extension', extension]), true);
  assert.equal(await firstExtensionIs(extension, [...cli, `--extension=${extension}`]), true);
  assert.equal(await firstExtensionIs(extension, [...cli, '-e', other, '-e', extension]), false);
  assert.equal(await firstExtensionIs(extension, [...cli, '-e', 'builtin:mcp', '-e', extension]), false);
  assert.equal(await firstExtensionIs(extension, [...cli, '--', '-e', extension]), false);
  assert.equal(await firstExtensionIs(extension, [...cli]), false);
  assert.equal(await firstExtensionIs(extension, [...cli, '-e', '/not/an/extension']), false);
});
