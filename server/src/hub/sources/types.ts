/**
 * Agents HQ: where agents come from.
 *
 * A source only ever reads. It reports which agents exist right now and what
 * they are doing; the office turns that into characters. No source can type
 * into an agent, start or stop one, or change any file it reads.
 */

export type AgentStatus = 'idle' | 'working' | 'blocked' | 'done' | 'unknown';

export interface AgentSnapshot {
  /** Stable per agent and unique across sources, e.g. "claude:<session id>". */
  key: string;
  /** Project the agent works in; it decides the room. */
  project: string;
  /** Session title, '' when unknown. */
  title: string;
  status: AgentStatus;
  /** Short live activity line while working, e.g. "Bash: npm test". */
  activity: string;
  /** Kinds of subagents running right now, e.g. ["Explore", "general-purpose"]. */
  subagents: string[];
  /** Which program the agent is: "Claude Code", "Codex". */
  kind: string;
  /** Whether the source can bring this agent's terminal to the front. */
  canFocus: boolean;
}

export interface AgentSource {
  /** Shown in the server log only. */
  readonly name: string;
  /** Current agents. Throws when the source is unreachable. */
  poll(): Promise<AgentSnapshot[]>;
  /** Recent output of one agent as plain text, for the detail panel. */
  read(key: string): Promise<string>;
  /** Bring the agent's terminal to the front, when the source supports it. */
  focus?(key: string): Promise<void>;
}
