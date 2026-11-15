export interface ToolCall {
  name: string;
  path?: string;
  query?: string;
  paths?: string | string[];
  command?: string;
  limit?: number;
  startLine?: number;
  startColumn?: number;
  lineCount?: number;
}

export type ChangeProposal =
  | { path: string; action: 'create'; baseHash: null; content: string }
  | { path: string; action: 'replace'; baseHash: string; content: string }
  | { path: string; action: 'edit'; baseHash: string; edits: { oldText: string; newText: string }[] }
  | { path: string; action: 'delete'; baseHash: string };

export interface DirectorySnapshot {
  path: string;
  target: string;
  identity: string;
  hash: string;
  files: { path: string; hash: string; size: number; bytes?: Buffer }[];
  directories: string[];
  size: number;
}

interface PreparedBase {
  path: string;
  target: string;
  content: string;
  original: string;
  expectedHash: string | null;
  taskId?: string;
  previewId?: string;
  appliedHash?: string | null;
  diskHash?: string | null;
}
export type PreparedChange =
  | (PreparedBase & { action: 'create' | 'replace' | 'edit'; directory: false })
  | (PreparedBase & {
      action: 'delete';
      directory: false;
      binary: boolean;
      originalBytes: Buffer;
      expectedDiskHash: string;
    })
  | (PreparedBase & {
      action: 'delete';
      directory: true;
      directorySnapshot: DirectoryBackup;
      expectedDiskHash: string;
      partialDirectory?: boolean;
    });

export interface FileInfo {
  path: string;
  kind: 'file';
  hash: string;
  hashType: 'sha256-bytes';
  size: number;
}

export interface DirectoryBackup extends Omit<DirectorySnapshot, 'files'> {
  files: (DirectorySnapshot['files'][number] & { bytes: Buffer })[];
}

export interface CommandResult {
  approved?: boolean;
  message?: string;
  command?: string;
  exitCode?: number | null;
  output?: string;
  timedOut?: boolean;
  cancelled?: boolean;
  truncated?: boolean;
  encoding?: string;
}
export interface ToolResult extends CommandResult {
  path?: string;
  kind?: 'file' | 'directory';
  hash?: string;
  content?: string;
  size?: number;
  startLine?: number;
  endLine?: number;
  files?: string[];
  matches?: { path: string; line: number; text: string }[];
}
export interface ToolObservation {
  call: ToolCall;
  result?: ToolResult;
  error?: string;
}
export interface HistoryEntry {
  kind?: string;
  role?: string;
  text?: string;
  observations?: ToolObservation[];
  [key: string]: unknown;
}
export type AgentReply =
  | { kind: 'tools'; calls: ToolCall[]; deferred?: string[] }
  | { kind: 'changes'; files: ChangeProposal[]; summary?: string }
  | { kind: 'done'; message: string };
export interface HostEvent {
  type: string;
  [key: string]: unknown;
}
export interface AgentOptions {
  store: import('../src/workspace').WorkspaceStore;
  transport: {
    promptCharacterLimit?: number;
    request(prompt: string, id: string, status: (text: string) => void): Promise<AgentReply>;
    stop(): Promise<void>;
  };
  approveAndApply?: (changes: PreparedChange[], summary: string) => Promise<boolean>;
  runCommand?: (command: string) => Promise<CommandResult>;
  emit: (event: HostEvent) => void;
  conversation?: { role: string; text: string }[];
  mode?: 'agent' | 'ask' | 'plan';
  intent?: string;
  autoApprove?: boolean;
  unlimitedRounds?: boolean;
  maxRounds?: number;
  maxPromptCharacters?: number;
}
export interface ChangeHost {
  taskId?: string;
  starting?: boolean;
  stopRequested?: boolean;
  agent?: { running: boolean; cancelled: boolean } | null;
  checkpoints: { store: import('../src/workspace').WorkspaceStore; changes: PreparedChange[] }[];
  changedFiles: Map<
    string,
    { root: string; path: string; action: ChangeProposal['action']; id?: string; taskId?: string }
  >;
  previews: Map<string, string>;
  pending: {
    kind: 'command' | 'changes';
    resolve: (approved: boolean) => void;
    changes?: PreparedChange[];
    viewData: HostEvent;
  } | null;
  post(event: HostEvent): void;
  output: Pick<import('vscode').OutputChannel, 'append' | 'appendLine' | 'show'>;
  config(): Pick<import('vscode').WorkspaceConfiguration, 'get'>;
  runner: {
    encoding?: string;
    run(command: string, root: string, output: (text: string) => void): Promise<CommandResult>;
  };
}
export interface FolderInfo {
  path: string;
  kind: 'directory';
  hash: string;
  size: number;
  fileCount: number;
  directoryCount: number;
  entries: string[];
  truncated: boolean;
}
export interface ReadOptions {
  startLine?: number;
  startColumn?: number;
  lineCount?: number;
  maxCharacters?: number;
}
export interface FileRead {
  path: string;
  hash: string;
  content: string;
  complete?: boolean;
  startLine?: number;
  startColumn?: number;
  endLine?: number;
  totalLines?: number;
  nextLine?: number | null;
  nextColumn?: number | null;
}
