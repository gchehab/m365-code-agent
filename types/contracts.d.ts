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
      directorySnapshot: DirectorySnapshot;
      expectedDiskHash: string;
    });

export interface FileInfo {
  path: string;
  kind: 'file';
  hash: string;
  hashType: 'sha256-bytes';
  size: number;
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
