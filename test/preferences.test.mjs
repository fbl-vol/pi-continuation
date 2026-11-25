import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomicJson } from '../src/store.mjs';
import { defaultDeliveryPreferences, readDeliveryPreferences,
  saveDeliveryPreferences, readAssignmentDeliveryPreferences,
  saveAssignmentDeliveryPreferences } from '../src/preferences.mjs';

test('new assignments snapshot defaults, and assignment overrides do not rewrite per-user choices', async t => {
  const root = await mkdtemp(join(tmpdir(), 'delivery-preferences-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const defaults = defaultDeliveryPreferences();
  assert.deepEqual(await readDeliveryPreferences(root), defaults);
  assert.equal(defaults.fixReviewFindings, 'Ask First');
  const selected = { ...defaults, pushBranch: 'Off', fixReviewFindings: 'Automatic' };
  await saveDeliveryPreferences(root, selected);
  assert.deepEqual(await readDeliveryPreferences(root), selected);
  const grant = { id: 'b936e2c9-9e87-42de-9837-9b38f2a7dd0d', deliveryPreferences: selected };
  assert.deepEqual(await readAssignmentDeliveryPreferences(root, grant), selected);
  await saveAssignmentDeliveryPreferences(root, grant.id, { ...selected, pushBranch: 'Ask First' });
  assert.equal((await readAssignmentDeliveryPreferences(root, grant)).pushBranch, 'Ask First');
  assert.deepEqual(await readDeliveryPreferences(root), selected, 'assignment override does not alter user defaults');
});

test('legacy saved review-fix choices remain Ask First in defaults, snapshots and overrides', async t => {
  const root = await mkdtemp(join(tmpdir(), 'delivery-preferences-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const id = 'b936e2c9-9e87-42de-9837-9b38f2a7dd0d';
  const old = { ...defaultDeliveryPreferences(), fixReviewFindings: 'Automatically Fix', pushBranch: 'Off' };
  const expected = { ...old, fixReviewFindings: 'Ask First' };
  const persisted = { schemaVersion: 1, values: old };
  await atomicJson(join(root, 'delivery-preferences.json'), persisted);
  assert.deepEqual(await readDeliveryPreferences(root), expected);
  assert.deepEqual(await readAssignmentDeliveryPreferences(root, { id, deliveryPreferences: old }), expected);
  await atomicJson(join(root, `delivery-assignment-${id}.json`), { ...persisted, grantId: id });
  assert.deepEqual(await readAssignmentDeliveryPreferences(root, { id }), expected);
});

test('legacy assignments do not inherit automatic review, and malformed choices never grant effects', async t => {
  const root = await mkdtemp(join(tmpdir(), 'delivery-preferences-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const grant = { id: 'a936e2c9-9e87-42de-9837-9b38f2a7dd0d' };
  const old = await readAssignmentDeliveryPreferences(root, grant);
  assert.equal(old.startReview, 'Ask First');
  assert.equal(old.closeReviewPanes, 'Off');
  await assert.rejects(saveDeliveryPreferences(root, { ...old, pushBranch: 'Ship' }), /Invalid delivery preferences/);
  await atomicJson(join(root, 'delivery-preferences.json'), { schemaVersion: 1,
    values: { ...old, fixReviewFindings: 'Ignore user decision' } });
  await assert.rejects(readDeliveryPreferences(root), /Invalid delivery preferences/);
});
