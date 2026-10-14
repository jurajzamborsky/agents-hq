/**
 * Agents HQ: demo source (`agents-hq --demo`). Made-up agents in made-up
 * projects, so the office can be tried, filmed or screenshotted without
 * showing real work. Reads nothing from disk.
 */

import type { AgentSnapshot, AgentSource, AgentStatus } from './types.js';

interface DemoAgent {
  project: string;
  title: string;
  activities: string[];
  /** Seconds per cycle and the share of it spent working / waiting. */
  cycle: number;
  offset: number;
  subagent?: string;
}

const AGENTS: DemoAgent[] = [
  { project: 'web', title: 'New pricing page', activities: ['Edit · Pricing.tsx', 'Bash · npm run build', 'Read · plans.ts'], cycle: 150, offset: 0 },
  { project: 'web', title: 'Fix signup form validation', activities: ['Grep · validateEmail', 'Edit · SignupForm.tsx', 'Bash · npm test'], cycle: 110, offset: 40 },
  { project: 'mobile-app', title: 'Push notifications', activities: ['Edit · notifications.ts', 'WebSearch · expo push tokens'], cycle: 170, offset: 20, subagent: 'Explore' },
  { project: 'mobile-app', title: 'Dark mode', activities: ['Edit · theme.ts', 'Read · colors.json'], cycle: 130, offset: 90 },
  { project: 'marketing', title: 'Newsletter draft', activities: ['Write · newsletter.md', 'WebFetch · blog.example.com'], cycle: 140, offset: 60 },
  { project: 'marketing', title: 'Launch post variants', activities: ['Write · linkedin.md', 'Edit · x-thread.md'], cycle: 190, offset: 10 },
  { project: 'data', title: 'Weekly KPI report', activities: ['Bash · python report.py', 'Read · events.csv'], cycle: 160, offset: 120, subagent: 'general-purpose' },
];

export class DemoSource implements AgentSource {
  readonly name = 'demo';
  private readonly start = Date.now();

  async poll(): Promise<AgentSnapshot[]> {
    const t = (Date.now() - this.start) / 1000;
    return AGENTS.map((a, i) => {
      const phase = ((t + a.offset) % a.cycle) / a.cycle;
      let status: AgentStatus;
      if (phase < 0.55) status = 'working';
      else if (phase < 0.62 && i % 3 === 0) status = 'blocked';
      else if (phase < 0.75) status = 'done';
      else status = 'idle';
      const step = Math.floor((t + a.offset) / 9) % a.activities.length;
      return {
        key: `demo:${i}`,
        project: a.project,
        title: a.title,
        status,
        activity: status === 'working' ? a.activities[step] : '',
        subagents: status === 'working' && a.subagent && phase > 0.2 && phase < 0.45 ? [a.subagent] : [],
        kind: 'Demo',
        canFocus: false,
      };
    });
  }

  async read(key: string): Promise<string> {
    const a = AGENTS[Number(key.slice('demo:'.length))];
    if (!a) throw new Error('unknown agent');
    return [`› ${a.title}`, ...a.activities.map((s) => `  ⎿ ${s}`), '● This is a demo agent. Start Agents HQ without --demo to see your own.'].join('\n\n');
  }
}
