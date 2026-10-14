/**
 * Agents HQ: Codex CLI source (OpenAI's terminal agent).
 *
 * Codex writes each session as ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl.
 * This source reads the end of recently changed files, nothing else. Like
 * the Claude Code source, "waiting for your approval" is a guess from a tool
 * call that has had no output for a while.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { describeTool, formatTranscript, minutes, projectName, readHead, readTail, type TranscriptItem } from './logUtils.js';
import type { AgentSnapshot, AgentSource, AgentStatus } from './types.js';

const ACTIVE_MS = minutes(process.env.HQ_ACTIVE_MINUTES, 45);
const DONE_MS = 5 * 60_000;
const STALE_MS = 4 * 60_000;
const RESCAN_MS = 5000;
const TAIL_BYTES = 512 * 1024;
const APPROVAL_GUESS_MS = 30_000;
const KEY_PREFIX = 'codex:';
const ROLLOUT_FILE = /^rollout-[\w.:-]+\.jsonl$/;

interface Pending {
  name: string;
  input: Record<string, unknown>;
  since: number;
}

interface Parsed {
  last: 'prompt' | 'working' | 'final' | 'interrupted' | 'none';
  title: string;
  pending: Map<string, Pending>;
}

interface Tracked {
  file: string;
  project: string;
  mtimeMs: number;
  size: number;
  parsed: Parsed;
}

export class CodexLogSource implements AgentSource {
  readonly name = 'codex-logs';
  private readonly root: string;
  private readonly tracked = new Map<string, Tracked>(); // by file name
  private lastScan = 0;

  constructor(home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex')) {
    this.root = path.join(home, 'sessions');
  }

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
    for (const [id, t] of this.tracked) {
      let stat: fs.Stats;
      try {
        stat = fs.statSync(t.file);
      } catch {
        this.tracked.delete(id);
        continue;
      }
      if (now - stat.mtimeMs > ACTIVE_MS) {
        this.tracked.delete(id);
        continue;
      }
      if (stat.mtimeMs !== t.mtimeMs || stat.size !== t.size) {
        t.mtimeMs = stat.mtimeMs;
        t.size = stat.size;
        t.parsed = parseRollout(readTail(t.file, TAIL_BYTES));
      }
      result.push(snapshot(id, t, now));
    }
    return result;
  }

  async read(key: string): Promise<string> {
    const t = this.tracked.get(key.slice(KEY_PREFIX.length));
    if (!t) throw new Error('unknown agent');
    return formatTranscript(transcriptItems(readTail(t.file, TAIL_BYTES)));
  }

  /** Only today's and yesterday's folders can hold a session active within the window. */
  private scan(now: number): void {
    for (const day of [0, 1]) {
      const d = new Date(now - day * 86_400_000);
      const dir = path.join(
        this.root,
        String(d.getFullYear()),
        String(d.getMonth() + 1).padStart(2, '0'),
        String(d.getDate()).padStart(2, '0'),
      );
      let names: string[];
      try {
        names = fs.readdirSync(dir);
      } catch {
        continue;
      }
      for (const name of names) {
        if (!ROLLOUT_FILE.test(name) || this.tracked.has(name)) continue;
        const file = path.join(dir, name);
        let stat: fs.Stats;
        try {
          stat = fs.statSync(file);
        } catch {
          continue;
        }
        if (!stat.isFile() || now - stat.mtimeMs > ACTIVE_MS) continue;
        this.tracked.set(name, {
          file,
          project: projectName(sessionCwd(file)),
          mtimeMs: stat.mtimeMs,
          size: stat.size,
          parsed: parseRollout(readTail(file, TAIL_BYTES)),
        });
      }
    }
  }
}

function snapshot(id: string, t: Tracked, now: number): AgentSnapshot {
  const p = t.parsed;
  let activity = '';
  let blocked = false;
  for (const call of p.pending.values()) {
    activity = describeTool(call.name, call.input);
    if (now - call.since > APPROVAL_GUESS_MS) blocked = true;
  }
  const age = now - t.mtimeMs;
  let status: AgentStatus;
  if (blocked) status = 'blocked';
  else if (p.pending.size > 0) status = 'working';
  else if (p.last === 'final') status = age < DONE_MS ? 'done' : 'idle';
  else if (p.last === 'interrupted' || p.last === 'none') status = 'idle';
  else status = age < STALE_MS ? 'working' : 'idle';
  return {
    key: KEY_PREFIX + id,
    project: t.project,
    title: p.title,
    status,
    activity: status === 'working' ? activity : '',
    subagents: [],
    kind: 'Codex',
    canFocus: false,
  };
}

// ── Parsing ────────────────────────────────────────────────────

type Entry = Record<string, unknown>;

function* items(lines: string[]): Generator<{ type: string; payload: Entry; at: number }> {
  for (const line of lines) {
    if (!line) continue;
    try {
      const e = JSON.parse(line) as Entry;
      const payload = e.payload;
      if (typeof e.type !== 'string' || !payload || typeof payload !== 'object') continue;
      const at = typeof e.timestamp === 'string' ? Date.parse(e.timestamp) : NaN;
      yield { type: e.type, payload: payload as Entry, at: Number.isNaN(at) ? Date.now() : at };
    } catch {
      // cut or half-written line
    }
  }
}

function parseArgs(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>;
  if (typeof raw !== 'string') return {};
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function messageText(payload: Entry): string {
  const content = payload.content;
  if (!Array.isArray(content)) return typeof payload.message === 'string' ? payload.message : '';
  return content
    .map((c) => (c && typeof c === 'object' && typeof (c as Entry).text === 'string' ? ((c as Entry).text as string) : ''))
    .join('\n');
}

/** Codex injects environment and instruction blocks as user messages. */
const isInjected = (text: string) => /^\s*<(environment_context|user_instructions|permissions|INSTRUCTIONS)/i.test(text);

function parseRollout(lines: string[]): Parsed {
  const parsed: Parsed = { last: 'none', title: '', pending: new Map() };
  for (const { type, payload, at } of items(lines)) {
    const kind = payload.type;
    if (type === 'event_msg') {
      if (kind === 'task_started') parsed.last = 'working';
      else if (kind === 'task_complete') {
        parsed.last = 'final';
        parsed.pending.clear();
      } else if (kind === 'turn_aborted') {
        parsed.last = 'interrupted';
        parsed.pending.clear();
      } else if (kind === 'user_message' && typeof payload.message === 'string' && !isInjected(payload.message)) {
        parsed.last = 'prompt';
        if (!parsed.title) parsed.title = payload.message.replace(/\s+/g, ' ').trim().slice(0, 80);
      }
      continue;
    }
    if (type !== 'response_item') continue;
    if ((kind === 'function_call' || kind === 'custom_tool_call' || kind === 'local_shell_call') && typeof payload.call_id === 'string') {
      const name = typeof payload.name === 'string' ? payload.name : kind === 'local_shell_call' ? 'local_shell' : 'tool';
      const input = kind === 'local_shell_call' ? parseArgs(payload.action) : parseArgs(payload.arguments ?? payload.input);
      parsed.pending.set(payload.call_id, { name, input, since: at });
      if (parsed.last !== 'final') parsed.last = 'working';
    } else if ((kind === 'function_call_output' || kind === 'custom_tool_call_output') && typeof payload.call_id === 'string') {
      parsed.pending.delete(payload.call_id);
    } else if (kind === 'message' && payload.role === 'assistant' && parsed.last === 'none') {
      // Older logs without task events: an answer ends the turn.
      parsed.last = 'final';
    }
  }
  return parsed;
}

function sessionCwd(file: string): string {
  for (const { type, payload } of items(readHead(file, 64 * 1024))) {
    if ((type === 'session_meta' || type === 'turn_context') && typeof payload.cwd === 'string') return payload.cwd;
  }
  return '';
}

function transcriptItems(lines: string[]): TranscriptItem[] {
  const out: TranscriptItem[] = [];
  for (const { type, payload } of items(lines)) {
    if (type !== 'response_item') continue;
    if (payload.type === 'message') {
      const text = messageText(payload);
      if (!text.trim() || isInjected(text)) continue;
      if (payload.role === 'user') out.push({ kind: 'you', text });
      else if (payload.role === 'assistant') out.push({ kind: 'agent', text });
    } else if (payload.type === 'function_call' || payload.type === 'custom_tool_call') {
      const name = typeof payload.name === 'string' ? payload.name : 'tool';
      out.push({ kind: 'tool', text: describeTool(name, parseArgs(payload.arguments ?? payload.input)) });
    }
  }
  return out;
}
