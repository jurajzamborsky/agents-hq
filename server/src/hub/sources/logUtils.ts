/**
 * Agents HQ: shared helpers for the session-log sources. Read-only file access.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export function minutes(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return (Number.isFinite(n) && n > 0 ? n : fallback) * 60_000;
}

/** The last `bytes` of a file as lines; a line cut by the window is dropped. */
export function readTail(file: string, bytes: number): string[] {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const buffer = Buffer.alloc(size - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);
    const lines = buffer.toString('utf-8').split('\n');
    if (start > 0) lines.shift();
    return lines;
  } catch {
    return [];
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

/** The first `bytes` of a file as lines. */
export function readHead(file: string, bytes: number): string[] {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, 'r');
    const buffer = Buffer.alloc(bytes);
    const read = fs.readSync(fd, buffer, 0, bytes, 0);
    const lines = buffer.subarray(0, read).toString('utf-8').split('\n');
    if (read === bytes) lines.pop();
    return lines;
  } catch {
    return [];
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

/** Room name for a working folder: its last segment, "~" for the home folder. */
export function projectName(cwd: string): string {
  if (!cwd) return '?';
  const clean = cwd.replace(/[\\/]+$/, '');
  if (clean === os.homedir()) return '~';
  return path.basename(clean).slice(0, 40) || '?';
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const short = (text: string, max: number) => {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
};

/** One short, language-neutral line for a tool call, e.g. "Edit · App.tsx". */
export function describeTool(name: string, input: Record<string, unknown>): string {
  const file = str(input.file_path) || str(input.notebook_path) || str(input.path);
  switch (name) {
    case 'Bash':
    case 'shell':
    case 'exec_command':
    case 'local_shell': {
      const command = Array.isArray(input.command) ? input.command.map(String).join(' ') : str(input.command) || str(input.cmd);
      return `${name === 'Bash' ? 'Bash' : 'Shell'} · ${short(str(input.description) || command, 60)}`;
    }
    case 'Read':
    case 'Edit':
    case 'Write':
    case 'MultiEdit':
    case 'NotebookEdit':
      return file ? `${name} · ${path.basename(file)}` : name;
    case 'Grep':
    case 'Glob':
      return `${name} · ${short(str(input.pattern), 50)}`;
    case 'WebFetch': {
      try {
        return `WebFetch · ${new URL(str(input.url)).hostname}`;
      } catch {
        return 'WebFetch';
      }
    }
    case 'WebSearch':
      return `WebSearch · ${short(str(input.query), 50)}`;
    case 'apply_patch':
      return 'Edit · patch';
    default:
      return short(name.replace(/^mcp__/, '').replace(/__/g, ' · '), 60);
  }
}

export interface TranscriptItem {
  kind: 'you' | 'agent' | 'tool';
  text: string;
}

/** The tail of a conversation as plain text for the detail panel. */
export function formatTranscript(items: TranscriptItem[], maxItems = 40): string {
  return items
    .slice(-maxItems)
    .map((item) => {
      if (item.kind === 'tool') return `  ⎿ ${item.text}`;
      const text = item.text.trim();
      const clipped = text.length > 700 ? `${text.slice(0, 700)}…` : text;
      return `${item.kind === 'you' ? '›' : '●'} ${clipped}`;
    })
    .join('\n\n');
}
