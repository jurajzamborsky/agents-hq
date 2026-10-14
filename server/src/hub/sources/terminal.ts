/**
 * Agents HQ: optional herdr source, the ONLY place that talks to herdr.
 * Used instead of the session logs when herdr is installed and running;
 * it adds exact agent states and "jump to terminal".
 *
 * Every call goes through herdr's official CLI (execFile, no shell) with an
 * argument list built here from a fixed set of read operations plus pane focus.
 * Nothing in this module can type into a pane, start or stop an agent, or close
 * anything — those herdr commands are simply never constructed. Pane targets
 * coming from the browser are validated against herdr's public ID format and
 * must belong to an agent the poller has actually seen.
 */

import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { AgentSnapshot, AgentSource, AgentStatus } from './types.js';

export interface TerminalAgent {
  paneId: string;
  workspaceId: string;
  agent: string;
  status: AgentStatus;
  title: string;
  cwd: string;
}

export interface TerminalWorkspace {
  workspaceId: string;
  label: string;
  number: number;
}

const CALL_TIMEOUT_MS = 5000;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
/** Public herdr pane ID, e.g. `w8:pM` or `wB:p14`. */
const PANE_ID_PATTERN = /^w[0-9A-Za-z]{1,8}:p[0-9A-Za-z]{1,8}$/;
const KNOWN_STATUSES = new Set<AgentStatus>(['idle', 'working', 'blocked', 'done', 'unknown']);

/** herdr, a terminal multiplexer for AI agents. Optional. */
const BINARY_NAME = 'herdr';

/** Resolve herdr binary once, to an absolute path, so a later PATH change
 *  cannot swap in a different executable. */
export function resolveTerminalBinary(): string | null {
  const candidates = [
    path.join('/opt/homebrew/bin', BINARY_NAME),
    path.join('/usr/local/bin', BINARY_NAME),
    path.join(os.homedir(), '.local', 'bin', BINARY_NAME),
    path.join(os.homedir(), '.cargo', 'bin', BINARY_NAME),
  ];
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (dir && path.isAbsolute(dir)) candidates.push(path.join(dir, BINARY_NAME));
  }
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return fs.realpathSync(candidate);
    } catch {
      // try the next one
    }
  }
  return null;
}

export class TerminalClient {
  constructor(private readonly binary: string) {}

  async listAgents(): Promise<TerminalAgent[]> {
    const result = (await this.callJson(['agent', 'list'])) as { agents?: unknown[] };
    const agents: TerminalAgent[] = [];
    for (const raw of result.agents ?? []) {
      const a = raw as Record<string, unknown>;
      const paneId = typeof a.pane_id === 'string' ? a.pane_id : '';
      if (!PANE_ID_PATTERN.test(paneId)) continue;
      const status = KNOWN_STATUSES.has(a.agent_status as AgentStatus)
        ? (a.agent_status as AgentStatus)
        : 'unknown';
      agents.push({
        paneId,
        workspaceId: typeof a.workspace_id === 'string' ? a.workspace_id : '',
        agent: typeof a.agent === 'string' ? a.agent : '',
        status,
        title: typeof a.terminal_title_stripped === 'string' ? a.terminal_title_stripped.trim() : '',
        cwd: typeof a.cwd === 'string' ? a.cwd : '',
      });
    }
    return agents;
  }

  async listWorkspaces(): Promise<TerminalWorkspace[]> {
    const result = (await this.callJson(['workspace', 'list'])) as { workspaces?: unknown[] };
    return (result.workspaces ?? []).map((raw) => {
      const w = raw as Record<string, unknown>;
      return {
        workspaceId: typeof w.workspace_id === 'string' ? w.workspace_id : '',
        label: typeof w.label === 'string' ? w.label : '',
        number: typeof w.number === 'number' ? w.number : 0,
      };
    });
  }

  /** What the agent's pane shows right now, as plain text. Deliberately the
   *  visible viewport only: reading further back makes herdr scroll the
   *  agent's screen to collect history, which could get in the way while you
   *  type in that pane. */
  async readAgent(paneId: string): Promise<string> {
    assertPaneId(paneId);
    return this.call(['agent', 'read', paneId, '--source', 'visible', '--format', 'text']);
  }

  /** Bottom-of-screen snapshot herdr uses for its own state detection. Cheap,
   *  and it holds the agent's live spinner line while it works. */
  async readDetection(paneId: string): Promise<string> {
    assertPaneId(paneId);
    return this.call(['agent', 'read', paneId, '--source', 'detection', '--format', 'text']);
  }

  /** Bring the agent's pane to the front inside herdr. */
  async focusAgent(paneId: string): Promise<void> {
    assertPaneId(paneId);
    await this.call(['agent', 'focus', paneId]);
  }

  private async callJson(args: string[]): Promise<Record<string, unknown>> {
    const stdout = await this.call(args);
    const parsed = JSON.parse(stdout) as { result?: Record<string, unknown> };
    return parsed.result ?? {};
  }

  private call(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(
        this.binary,
        args,
        {
          timeout: CALL_TIMEOUT_MS,
          maxBuffer: MAX_OUTPUT_BYTES,
          // Clean environment: no inherited pane/--current context and
          // no PATH lookups — herdr finds its default socket from HOME.
          env: { HOME: os.homedir(), PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8' },
          shell: false,
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          if (error) {
            reject(new Error(sourceErrorMessage(stdout) || firstLine(stderr) || error.message));
            return;
          }
          resolve(stdout);
        },
      );
    });
  }
}

function assertPaneId(paneId: string): void {
  if (!PANE_ID_PATTERN.test(paneId)) throw new Error('invalid pane id');
}

/** herdr reports some errors as JSON on stdout: {"error":{"code","message"}}. */
function sourceErrorMessage(stdout: string): string {
  try {
    const parsed = JSON.parse(stdout) as { error?: { message?: unknown } };
    return typeof parsed.error?.message === 'string' ? parsed.error.message.slice(0, 300) : '';
  } catch {
    return '';
  }
}

function firstLine(text: string): string {
  return text.split('\n').find((l) => l.trim())?.trim().slice(0, 300) ?? '';
}

// ── Source adapter ─────────────────────────────────────────────

const MAX_SUBAGENTS_PER_AGENT = 8;
/** Claude Code's spinner glyphs at the start of its live status line. */
const SPINNER_LINE = /^[·✢✳✶✻✽*]\s+(.+?)\s*(?:\(.*\))?\s*$/u;
/** A background subagent row in Claude Code's agent list: "◯ general-purpose  Task…". */
const SUBAGENT_LINE = /^(?:❯\s*)?\s*◯\s+([A-Za-z0-9_-]+)\s{2,}(.+?)(?:\s{2,}\S.*)?$/u;

function parseDetection(text: string): { activity: string; subagents: string[] } {
  let activity = '';
  const subagents: string[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trimEnd();
    const spin = SPINNER_LINE.exec(trimmed);
    if (spin) activity = spin[1].slice(0, 80);
    const sub = SUBAGENT_LINE.exec(trimmed);
    if (sub && subagents.length < MAX_SUBAGENTS_PER_AGENT) subagents.push(sub[1]);
  }
  return { activity, subagents };
}

const KEY_PREFIX = 'term:';

export class TerminalSource implements AgentSource {
  readonly name = 'terminal';
  private readonly client: TerminalClient;

  constructor(binary: string) {
    this.client = new TerminalClient(binary);
  }

  async poll(): Promise<AgentSnapshot[]> {
    const [agents, workspaces] = await Promise.all([this.client.listAgents(), this.client.listWorkspaces()]);
    const labels = new Map(workspaces.map((w) => [w.workspaceId, w.label]));
    const result: AgentSnapshot[] = [];
    for (const a of agents) {
      if (a.agent === '') continue;
      let activity = '';
      let subagents: string[] = [];
      if (a.status === 'working' || a.status === 'blocked') {
        try {
          ({ activity, subagents } = parseDetection(await this.client.readDetection(a.paneId)));
        } catch {
          // The status still holds; only the activity line is missing.
        }
      }
      result.push({
        key: KEY_PREFIX + a.paneId,
        project: labels.get(a.workspaceId) || path.basename(a.cwd) || a.workspaceId,
        title: a.title && a.title !== 'Claude Code' ? a.title : '',
        status: a.status,
        activity,
        subagents,
        kind: a.agent,
        canFocus: true,
      });
    }
    return result;
  }

  read(key: string): Promise<string> {
    return this.client.readAgent(key.slice(KEY_PREFIX.length));
  }

  async focus(key: string): Promise<void> {
    await this.client.focusAgent(key.slice(KEY_PREFIX.length));
    bringTerminalToFront();
  }
}

/** herdr switches the pane inside its own window; on macOS this
 *  also brings Ghostty (when installed) to the front. No browser input reaches it. */
function bringTerminalToFront(): void {
  if (process.platform !== 'darwin') return;
  execFile('/usr/bin/open', ['-a', 'Ghostty'], { timeout: 3000 }, () => {
    // Ghostty missing or already frontmost: nothing to do.
  });
}
