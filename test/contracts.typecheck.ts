import { normalizeToolCall } from '../src/tool-call';
import type { ChangeProposal, PreparedChange, ToolCall } from '../types/contracts';

const call: ToolCall = normalizeToolCall({ name: 'read_file', path: 'main.js' });
call.path?.toUpperCase();
// @ts-expect-error A path must remain text after normalization.
call.path = 123;
// @ts-expect-error A deletion cannot have a null creation hash.
const badDelete: ChangeProposal = { path: 'old', action: 'delete', baseHash: null };
// @ts-expect-error A full replacement requires complete content.
const incompleteReplace: ChangeProposal = { path: 'main.js', action: 'replace', baseHash: 'hash' };
function inspectPrepared(change: PreparedChange) {
  if (change.directory) return change.directorySnapshot.files;
  // @ts-expect-error Ordinary file changes cannot be used as directory snapshots.
  return change.directorySnapshot.files;
}
void badDelete;
void incompleteReplace;
void inspectPrepared;
