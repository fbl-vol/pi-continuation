import { join } from 'node:path';
import { atomicJson, ensureRoot, readJson } from './store.mjs';

export const deliveryFields = [
  { key: 'startReview', label: 'Start review', choices: ['Automatic', 'Ask First'], initial: 'Automatic' },
  { key: 'fixReviewFindings', label: 'Fix review findings', choices: ['Automatically Fix', 'Ask First'], initial: 'Ask First' },
  { key: 'pushBranch', label: 'Push branch', choices: ['Automatic', 'Ask First', 'Off'], initial: 'Ask First' },
  { key: 'openPr', label: 'Open PR', choices: ['Automatic', 'Ask First', 'Off'], initial: 'Ask First' },
  { key: 'closeReviewPanes', label: 'Close review panes', choices: ['Automatic', 'Off'], initial: 'Off' },
];

const pathFor = root => join(root, 'delivery-preferences.json');
const assignmentPath = (root, id) => join(root, `delivery-assignment-${id}.json`);
export const defaultDeliveryPreferences = () => Object.fromEntries(deliveryFields.map(field => [field.key, field.initial]));

export function validateDeliveryPreferences(values) {
  if (!values || typeof values !== 'object' || Array.isArray(values) ||
      Object.keys(values).length !== deliveryFields.length ||
      deliveryFields.some(field => !field.choices.includes(values[field.key])))
    throw new Error('Invalid delivery preferences; inspect saved choices before using them');
  return values;
}

export async function readDeliveryPreferences(root) {
  try {
    const saved = await readJson(pathFor(root));
    if (saved.schemaVersion !== 1) throw new Error('Unsupported delivery preferences format');
    return validateDeliveryPreferences(saved.values);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return defaultDeliveryPreferences();
  }
}

export async function saveDeliveryPreferences(root, values) {
  validateDeliveryPreferences(values);
  await ensureRoot(root);
  await atomicJson(pathFor(root), { schemaVersion: 1, values });
}

export async function readAssignmentDeliveryPreferences(root, grant) {
  try {
    const saved = await readJson(assignmentPath(root, grant.id));
    if (saved.schemaVersion !== 1 || saved.grantId !== grant.id)
      throw new Error('Assignment delivery preferences changed');
    return validateDeliveryPreferences(saved.values);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    // Older assignments did not opt in to new automatic defaults.
    return validateDeliveryPreferences(grant.deliveryPreferences ?? {
      ...defaultDeliveryPreferences(), startReview: 'Ask First' });
  }
}

export async function saveAssignmentDeliveryPreferences(root, id, values) {
  validateDeliveryPreferences(values);
  await atomicJson(assignmentPath(root, id), { schemaVersion: 1, grantId: id, values });
}

// A saved preference cannot grant the currently unapproved automatic-fix path.
export function effectiveDeliveryPreferences(values) {
  const saved = validateDeliveryPreferences(values);
  return { ...saved, fixReviewFindings: 'Ask First' };
}
