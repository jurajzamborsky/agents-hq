/**
 * Agents HQ: Claude Code source.
 *
 * Claude Code writes every session as a JSONL file under
 * ~/.claude/projects/<project>/<session>.jsonl. This source only reads the end
 * of recently changed files to tell what each session is doing. It never
 * writes there, never installs hooks and never touches Claude's settings.
 *
 * The log has no explicit "waiting for your approval" marker, so that state is
 * a heuristic: a tool call that has had no result for a while.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { describeTool, formatTranscript, minutes, projectName, readHead, readTail, type TranscriptItem } from './logUtils.js';
import type { AgentSnapshot, AgentSource, AgentStatus } from './types.js';

/** Sessions untouched this long are treated as closed. */
const ACTIVE_MS = minutes(process.env.HQ_ACTIVE_MINUTES, 45);
/** A finished session counts as "done" (fresh result) this long, then idle. */
const DONE_MS = 5 * 60_000;
/** No log activity this long while "working" means the session died mid-turn. */
const STALE_MS = 4 * 60_000;
const RESCAN_MS = 5000;
const TAIL_BYTES = 512 * 1024;
/** Tools that ask you something by design. */
const ASKING_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode']);
/** Tools that run subagents; their own log is elsewhere, so they stay silent here for long. */
const SUBAGENT_TOOLS = new Set(['Agent', 'Task']);
/** A pending call this old probably waits for your approval. Shell commands get longer. */
const APPROVAL_GUESS_MS = 8000;
const SHELL_APPROVAL_GUESS_MS = 30_000;
const KEY_PREFIX = 'claude:';
const SESSION_ID = /^[0-9a-f-]{36}$/;

interface Pending {
  name: string;
  input: Record<string, unknown>;
  since: number;
}

interface Parsed {
  title: string;
  ended: boolean;
  /** What the last entry was. */
  last: 'prompt' | 'result' | 'assistant' | 'final' | 'interrupted' | 'none';
  lastAt: number;
  pending: Map<string, Pending>;
}

interface Tracked {
  file: string;
  project: string;
  mtimeMs: number;
  size: number;
  parsed: Parsed;
}

export class ClaudeLogSource implements AgentSource {
  readonly name = 'claude-code-logs';
  private readonly root: string;
  private readonly tracked = new Map<string, Tracked>(); // by session id
  private lastScan = 0;

  constructor(configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')) {
    this.root = path.join(configDir, 'projects');
  }

  /** Whether Claude Code has ever run on this machine. */
  available(): boolean {
    return fs.existsSync(this.root);
  }

  async poll(): Promise<AgentSnapshot[]> {
    const now = Date.now();
    if (now - this.lastScan >= RESCAN_MS) {
      this.scan(now);
      this.lastScan = now;
    }

    const result: AgentSnapshot[] = [];
    for (const [sessionId, t] of this.tracked) {
      let stat: fs.Stats;
      try {
        stat = fs.statSync(t.file);
      } catch {
        this.tracked.delete(sessionId);
        continue;
      }
      if (now - stat.mtimeMs > ACTIVE_MS) {
        this.tracked.delete(sessionId);
        continue;
      }
      if (stat.mtimeMs !== t.mtimeMs || stat.size !== t.size) {
        t.mtimeMs = stat.mtimeMs;
        t.size = stat.size;
        t.parsed = parseSession(readTail(t.file, TAIL_BYTES));
      }
      if (t.parsed.ended) continue;
      result.push(this.snapshot(sessionId, t, now));
    }
    return result;
  }

  async read(key: string): Promise<string> {
    const t = this.tracked.get(key.slice(KEY_PREFIX.length));
    if (!t) throw new Error('unknown agent');
    return formatTranscript(transcriptItems(readTail(t.file, TAIL_BYTES)));
  }

  private scan(now: number): void {
    let projectDirs: fs.Dirent[];
    try {
      projectDirs = fs.readdirSync(this.root, { withFileTypes: true });
    } catch {
      return;
    }
    for (const dir of projectDirs) {
      if (!dir.isDirectory()) continue;
      const dirPath = path.join(this.root, dir.name);
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dirPath, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
        const sessionId = entry.name.slice(0, -'.jsonl'.length);
        if (!SESSION_ID.test(sessionId) || this.tracked.has(sessionId)) continue;
        const file = path.join(dirPath, entry.name);
        let stat: fs.Stats;
        try {
          stat = fs.statSync(file);
        } catch {
          continue;
        }
        if (now - stat.mtimeMs > ACTIVE_MS) continue;
        this.tracked.set(sessionId, {
          file,
          project: projectName(sessionCwd(file)),
          mtimeMs: stat.mtimeMs,
          size: stat.size,
          parsed: parseSession(readTail(file, TAIL_BYTES)),
        });
      }
    }
  }

  private snapshot(sessionId: string, t: Tracked, now: number): AgentSnapshot {
    const p = t.parsed;
    const subagents: string[] = [];
    let blocked = false;
    let activity = '';
    for (const call of p.pending.values()) {
      if (SUBAGENT_TOOLS.has(call.name)) {
        const kind = typeof call.input.subagent_type === 'string' ? call.input.subagent_type : 'general-purpose';
        subagents.push(kind.slice(0, 40));
        continue;
      }
      activity = describeTool(call.name, call.input);
      const wait = call.name === 'Bash' ? SHELL_APPROVAL_GUESS_MS : APPROVAL_GUESS_MS;
      if (ASKING_TOOLS.has(call.name) || now - call.since > wait) blocked = true;
    }

    let status: AgentStatus;
    const age = now - t.mtimeMs;
    if (blocked) status = 'blocked';
    else if (p.pending.size > 0) status = 'working';
    else if (p.last === 'final') status = age < DONE_MS ? 'done' : 'idle';
    else if (p.last === 'interrupted' || p.last === 'none') status = 'idle';
    else status = age < STALE_MS ? 'working' : 'idle';

    return {
      key: KEY_PREFIX + sessionId,
      project: t.project,
      title: p.title,
      status,
      activity: status === 'working' ? activity : '',
      subagents: subagents.slice(0, 8),
      kind: 'Claude Code',
      canFocus: false,
    };
  }
}

// ── Parsing ────────────────────────────────────────────────────

type Entry = Record<string, unknown>;

function* entries(lines: string[]): Generator<Entry> {
  for (const line of lines) {
    if (!line) continue;
    try {
      const value = JSON.parse(line) as unknown;
      if (value && typeof value === 'object' && !Array.isArray(value)) yield value as Entry;
    } catch {
      // A line cut by the tail window or a half-written line: skip it.
    }
  }
}

function contentBlocks(entry: Entry): Entry[] | string | null {
  const message = entry.message as Entry | undefined;
  const content = message?.content;
  if (typeof content === 'string') return content;
  return Array.isArray(content) ? (content.filter((b) => b && typeof b === 'object') as Entry[]) : null;
}

function timeOf(entry: Entry): number {
  const t = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN;
  return Number.isNaN(t) ? Date.now() : t;
}

const isCommandNoise = (text: string) => /^<(command-|local-command-)/.test(text.trim());

function parseSession(lines: string[]): Parsed {
  const parsed: Parsed = { title: '', ended: false, last: 'none', lastAt: 0, pending: new Map() };
  for (const e of entries(lines)) {
    if (e.type === 'ai-title' && typeof e.aiTitle === 'string') parsed.title = e.aiTitle.slice(0, 120);
    if (e.type === 'custom-title' && typeof e.customTitle === 'string') parsed.title = e.customTitle.slice(0, 120);
    if (e.type !== 'user' && e.type !== 'assistant') continue;
    if (e.isSidechain === true) continue;
    const blocks = contentBlocks(e);
    const at = timeOf(e);

    if (e.type === 'user') {
      if (e.isMeta === true) continue;
      const texts = typeof blocks === 'string' ? [blocks] : (blocks ?? []).filter((b) => b.type === 'text').map((b) => String(b.text ?? ''));
      for (const b of Array.isArray(blocks) ? blocks : []) {
        if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
          parsed.pending.delete(b.tool_use_id);
          parsed.last = 'result';
          parsed.lastAt = at;
        }
      }
      for (const text of texts) {
        if (/<command-name>\/(exit|quit)<\/command-name>/.test(text)) {
          parsed.ended = true;
          continue;
        }
        if (isCommandNoise(text)) continue;
        if (text.startsWith('[Request interrupted')) {
          parsed.pending.clear();
          parsed.last = 'interrupted';
        } else {
          parsed.ended = false;
          parsed.last = 'prompt';
        }
        parsed.lastAt = at;
      }
      continue;
    }

    // assistant
    const message = e.message as Entry | undefined;
    for (const b of Array.isArray(blocks) ? blocks : []) {
      if (b.type === 'tool_use' && typeof b.id === 'string' && typeof b.name === 'string') {
        const input = b.input && typeof b.input === 'object' ? (b.input as Record<string, unknown>) : {};
        parsed.pending.set(b.id, { name: b.name, input, since: at });
      }
    }
    parsed.last = message?.stop_reason === 'end_turn' && parsed.pending.size === 0 ? 'final' : 'assistant';
    parsed.lastAt = at;
  }
  return parsed;
}

/** The session's starting folder, from the first lines of its log (or the last ones). */
function sessionCwd(file: string): string {
  for (const lines of [readHead(file, 64 * 1024), readTail(file, 64 * 1024)]) {
    for (const e of entries(lines)) {
      if (typeof e.cwd === 'string' && e.cwd) return e.cwd;
    }
  }
  return '';
}

function transcriptItems(lines: string[]): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  for (const e of entries(lines)) {
    if ((e.type !== 'user' && e.type !== 'assistant') || e.isSidechain === true || e.isMeta === true) continue;
    const blocks = contentBlocks(e);
    if (typeof blocks === 'string') {
      if (e.type === 'user' && !isCommandNoise(blocks)) items.push({ kind: 'you', text: blocks });
      continue;
    }
    for (const b of blocks ?? []) {
      if (b.type === 'text' && typeof b.text === 'string') {
        if (e.type === 'user' && isCommandNoise(b.text)) continue;
        items.push({ kind: e.type === 'user' ? 'you' : 'agent', text: b.text });
      } else if (b.type === 'tool_use' && typeof b.name === 'string') {
        const input = b.input && typeof b.input === 'object' ? (b.input as Record<string, unknown>) : {};
        items.push({ kind: 'tool', text: describeTool(b.name, input) });
      }
    }
  }
  return items;
}
