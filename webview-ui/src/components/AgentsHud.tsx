import { useEffect, useState } from 'react';

import { roomName, t, useHqSettings, type StringKey } from '../hq/i18n.js';
import type { OfficeState } from '../office/engine/officeState.js';
import { transport } from '../transport/index.js';
import { Button } from './ui/Button.js';

/** How often the counters re-read the office and the open list asks the server. */
const COUNT_REFRESH_MS = 500;
const LIST_REFRESH_MS = 2000;

const WAITING = '#ff8f6b';
const WORKING = '#c6f05a';

interface ListedAgent {
  id: number;
  project: string;
  title: string;
  status: string;
  kind?: string;
  activity?: string;
  napping?: boolean;
  canFocus?: boolean;
}

/** Same rule the 3D view uses for the bubbles: permission bubble or "blocked" = waiting for you. */
function countAgents(officeState: OfficeState): { waiting: number; working: number } {
  let waiting = 0;
  let working = 0;
  for (const ch of officeState.characters.values()) {
    if (ch.isSubagent) continue;
    if (ch.bubbleType === 'permission' || officeState.agentRawStatus.get(ch.id) === 'blocked') waiting++;
    else if (ch.isActive) working++;
  }
  return { waiting, working };
}

function statusOf(a: ListedAgent): { key: StringKey; color: string; rank: number } {
  if (a.status === 'blocked') return { key: 'waiting', color: WAITING, rank: 0 };
  if (a.status === 'working') return { key: 'working', color: WORKING, rank: 1 };
  if (a.napping) return { key: 'listNap', color: 'var(--color-text-muted, #8a82a6)', rank: 3 };
  if (a.status === 'done') return { key: 'listDone', color: 'var(--color-text-muted, #8a82a6)', rank: 2 };
  return { key: 'listIdle', color: 'var(--color-text-muted, #8a82a6)', rank: 2 };
}

interface AgentsHudProps {
  officeState: OfficeState;
}

/**
 * Agents HQ: counters in the top right (waiting / working) in both views.
 * Click opens the agent list: who waits, who works, a jump to the agent detail
 * and, when the source supports it (herdr), straight to its terminal.
 * Read-only like the rest: focusing a terminal never sends input to an agent.
 */
export function AgentsHud({ officeState }: AgentsHudProps) {
  useHqSettings();
  const [counts, setCounts] = useState(() => countAgents(officeState));
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<ListedAgent[] | null>(null);
  const [focused, setFocused] = useState<{ id: number; ok: boolean } | null>(null);

  useEffect(() => {
    const timer = setInterval(() => setCounts(countAgents(officeState)), COUNT_REFRESH_MS);
    return () => clearInterval(timer);
  }, [officeState]);

  useEffect(() => {
    if (!open) return;
    const unsubscribe = transport.onMessage((raw) => {
      const msg = raw as unknown as Record<string, unknown>;
      if (msg.type === 'hubAgentList' && Array.isArray(msg.agents)) setList(msg.agents as ListedAgent[]);
      else if (msg.type === 'hubFocusResult') setFocused({ id: msg.id as number, ok: msg.ok === true });
    });
    const request = () => transport.send({ type: 'hubListAgents' } as never);
    request();
    const timer = setInterval(request, LIST_REFRESH_MS);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => {
      unsubscribe();
      clearInterval(timer);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const rows = (list ?? [])
    .map((a) => ({ a, s: statusOf(a) }))
    .sort((x, y) => x.s.rank - y.s.rank || x.a.project.localeCompare(y.a.project));
  const anyFocus = rows.some((r) => r.a.canFocus);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="absolute top-8 right-8 pixel-panel px-14 py-6 cursor-pointer text-inherit text-sm font-semibold flex items-center gap-14"
        style={{ zIndex: 50 }}
        aria-expanded={open}
        aria-label={t('hudList')}
        title={t('hudList')}
        data-testid="agents-hud"
      >
        <span style={{ color: counts.waiting ? WAITING : 'inherit' }}>● {t('hudWaiting', { n: counts.waiting })}</span>
        <span style={{ color: WORKING }}>● {t('hudWorking', { n: counts.working })}</span>
        <span aria-hidden="true" style={{ opacity: 0.8, fontSize: 16, lineHeight: 1 }}>☰</span>
      </button>

      {open && (
        <div
          className="absolute right-8 pixel-panel p-10 flex flex-col gap-8"
          style={{ top: 52, zIndex: 55, width: 'min(520px, calc(100vw - 32px))', maxHeight: 'calc(100% - 140px)' }}
          data-testid="agents-list"
        >
          <div className="flex items-center justify-between gap-8">
            <span className="text-lg font-bold">{t('listTitle')}</span>
            <Button variant="ghost" size="sm" onClick={() => setOpen(false)} aria-label={t('close')}>
              x
            </Button>
          </div>
          <div className="flex flex-col gap-4 overflow-auto">
            {list === null && <span className="text-sm text-text-muted">{t('loading')}</span>}
            {list !== null && rows.length === 0 && <span className="text-sm text-text-muted">{t('listEmpty')}</span>}
            {rows.map(({ a, s }) => (
              <div key={a.id} className="flex items-center gap-10 p-6 bg-bg-dark" style={{ borderRadius: 3 }}>
                <span aria-hidden="true" style={{ color: s.color, fontSize: 14 }}>●</span>
                <div className="flex flex-col flex-1 overflow-hidden" style={{ lineHeight: 1.25 }}>
                  <span className="text-xs text-text-muted overflow-hidden text-ellipsis whitespace-nowrap">
                    {roomName(a.project)} · <span style={{ color: s.color }}>{t(s.key)}</span>
                  </span>
                  <span className="text-sm overflow-hidden text-ellipsis whitespace-nowrap">{a.title || 'Agent'}</span>
                  {a.status === 'working' && a.activity && (
                    <span className="text-xs text-text-muted overflow-hidden text-ellipsis whitespace-nowrap">{a.activity}</span>
                  )}
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    officeState.selectedAgentId = a.id;
                    setOpen(false);
                  }}
                >
                  {t('listDetail')}
                </Button>
                {a.canFocus && (
                  <Button
                    variant="accent"
                    size="sm"
                    onClick={() => {
                      setFocused(null);
                      transport.send({ type: 'hubFocusAgent', id: a.id } as never);
                    }}
                    title={focused?.id === a.id ? t(focused.ok ? 'jumped' : 'jumpFailed') : t('jumpToTerminal')}
                  >
                    {focused?.id === a.id ? (focused.ok ? '✓' : '!') : t('listTerminal')}
                  </Button>
                )}
              </div>
            ))}
          </div>
          {list !== null && rows.length > 0 && !anyFocus && (
            <p className="m-0 text-xs text-text-muted" style={{ whiteSpace: 'pre-line', textWrap: 'pretty' }}>
              {t('listFocusHint')}
            </p>
          )}
        </div>
      )}
    </>
  );
}
