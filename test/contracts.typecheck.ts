import { normalizeToolCall } from '../src/tool-call';
import type { ChangeProposal, PreparedChange, ToolCall } from '../types/contracts';
import type { DirectoryBackup } from '../types/contracts';
import { ChangeController } from '../src/changes';
import { CodingAgent } from '../src/agent';
import { ExperimentalModelProvider } from '../src/model-provider';
import type * as vscode from 'vscode';
import type { WorkspaceStore } from '../src/workspace';

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

function checkExecution(
  controller: ChangeController,
  store: WorkspaceStore,
  changes: PreparedChange[],
  backup: DirectoryBackup,
) {
  // @ts-expect-error Review policy is a boolean, not model text.
  controller.stageAndApply(store, changes, 'review', 'approve');
  // @ts-expect-error Restore backups cannot contain an entry without original bytes.
  backup.files = [{ path: 'image.bin', hash: 'hash', size: 1 }];
  new CodingAgent({
    store,
    emit() {},
    transport: {
      async stop() {},
      async request() {
        return { kind: 'done', message: 'ok' };
      },
    },
    // @ts-expect-error Request limits must be numeric; unlimited is a separate option.
    maxRounds: 'unlimited',
  });
}
void checkExecution;

function checkModelProvider(provider: ExperimentalModelProvider) {
  const native: vscode.LanguageModelChatProvider = provider;
  return native;
}
void checkModelProvider;
