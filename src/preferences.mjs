import { join } from 'node:path';
import { atomicJson, ensureRoot, readJson } from './store.mjs';

export const deliveryFields = [
  { key: 'startReview', label: 'Start review', choices: ['Automatic', 'Ask First'], initial: 'Automatic' },
  { key: 'fixReviewFindings', label: 'Fix review findings', choices: ['Automatic', 'Ask First'], initial: 'Ask First' },
  { key: 'pushBranch', label: 'Push branch', choices: ['Automatic', 'Ask First', 'Off'], initial: 'Ask First' },
  { key: 'openPr', label: 'Open PR', choices: ['Automatic', 'Ask First', 'Off'], initial: 'Ask First' },
  { key: 'closeReviewPanes', label: 'Close review panes', choices: ['Automatic', 'Off'], initial: 'Off' },
];

const pathFor = root => join(root, 'delivery-preferences.json');
const assignmentPath = (root, id) => join(root, `delivery-assignment-${id}.json`);
export const defaultDeliveryPreferences = () => Object.fromEntries(deliveryFields.map(field => [field.key, field.initial]));

export const reviewFixPreferenceGuidance = 'Automatic is a workflow preference for confirmed in-scope independent findings only. ' +
  'Repository or assignment rules requiring human selection take precedence. Never release an existing wait, hold or pause based on this setting. ' +
  'Use the same writer and the original independent reviewers for re-verification. If the owner workflow does not support Automatic, use Ask First.';

function validateDeliveryPreferences(values) {
  if (!values || typeof values !== 'object' || Array.isArray(values) ||
      Object.keys(values).length !== deliveryFields.length ||
      deliveryFields.some(field => !field.choices.includes(values[field.key])))
    throw new Error('Invalid delivery preferences; inspect saved choices before using them');
  return values;
}

function decodeDeliveryPreferences(values) {
  // The legacy saved choice never took effect. Do not activate it on upgrade.
  return validateDeliveryPreferences(values?.fixReviewFindings === 'Automatically Fix' ?
    { ...values, fixReviewFindings: 'Ask First' } : values);
}

export async function readDeliveryPreferences(root) {
  try {
    const saved = await readJson(pathFor(root));
    if (saved.schemaVersion !== 1) throw new Error('Unsupported delivery preferences format');
    return decodeDeliveryPreferences(saved.values);
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
    return decodeDeliveryPreferences(saved.values);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    // Older assignments did not opt in to new automatic defaults.
    return decodeDeliveryPreferences(grant.deliveryPreferences ?? {
      ...defaultDeliveryPreferences(), startReview: 'Ask First' });
  }
}

export async function saveAssignmentDeliveryPreferences(root, id, values) {
  validateDeliveryPreferences(values);
  await atomicJson(assignmentPath(root, id), { schemaVersion: 1, grantId: id, values });
}
