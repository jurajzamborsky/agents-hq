/**
 * Agents HQ: picks the agent sources for this machine.
 *
 * HQ_SOURCE=auto (default): herdr when it is installed and
 * answers, otherwise the Claude Code and Codex session logs.
 * HQ_SOURCE=logs or HQ_SOURCE=terminal forces one of them; --demo shows
 * made-up agents instead.
 */

import { ClaudeLogSource } from './claudeLogs.js';
import { CodexLogSource } from './codexLogs.js';
import { DemoSource } from './demo.js';
import { resolveTerminalBinary, TerminalSource } from './terminal.js';
import type { AgentSnapshot, AgentSource } from './types.js';

export type { AgentSnapshot, AgentSource, AgentStatus } from './types.js';

class CombinedSource implements AgentSource {
  readonly name: string;

  constructor(private readonly sources: AgentSource[]) {
    this.name = sources.map((s) => s.name).join(' + ');
  }

  async poll(): Promise<AgentSnapshot[]> {
    const results = await Promise.allSettled(this.sources.map((s) => s.poll()));
    const ok = results.filter((r): r is PromiseFulfilledResult<AgentSnapshot[]> => r.status === 'fulfilled');
    if (ok.length === 0 && results.length > 0) throw (results[0] as PromiseRejectedResult).reason;
    return ok.flatMap((r) => r.value);
  }

  read(key: string): Promise<string> {
    return this.owner(key).read(key);
  }

  async focus(key: string): Promise<void> {
    const source = this.owner(key);
    if (!source.focus) throw new Error('focus not supported');
    await source.focus(key);
  }

  private owner(key: string): AgentSource {
    const prefix = key.slice(0, key.indexOf(':') + 1);
    const source = this.sources.find((s) => sourcePrefix(s) === prefix);
    if (!source) throw new Error('unknown agent');
    return source;
  }
}

function sourcePrefix(source: AgentSource): string {
  if (source instanceof TerminalSource) return 'term:';
  if (source instanceof ClaudeLogSource) return 'claude:';
  if (source instanceof CodexLogSource) return 'codex:';
  if (source instanceof DemoSource) return 'demo:';
  return '';
}

export async function createSource(demo = false): Promise<AgentSource> {
  if (demo) return new CombinedSource([new DemoSource()]);
  const mode = (process.env.HQ_SOURCE ?? 'auto').toLowerCase();

  if (mode !== 'logs') {
    const binary = resolveTerminalBinary();
    if (binary) {
      const terminal = new TerminalSource(binary);
      try {
        await terminal.poll();
        return new CombinedSource([terminal]);
      } catch (err) {
        if (mode === 'terminal') throw err;
      }
    } else if (mode === 'terminal') {
      throw new Error('herdr not found');
    }
  }

  // Both log sources are always on, so an agent installed later shows up
  // without a restart.
  return new CombinedSource([new ClaudeLogSource(), new CodexLogSource()]);
}
