import { useEffect, useRef, useState } from 'react';

import { t, useHqSettings, type StringKey } from '../hq/i18n.js';
import type { OfficeState } from '../office/engine/officeState.js';
import { transport } from '../transport/index.js';
import { Button } from './ui/Button.js';

/** How often the open panel asks the server for the agent's latest output. */
const OUTPUT_REFRESH_MS = 2000;

interface AgentDetail {
  id: number;
  workspace: string;
  title: string;
  status: string;
  kind?: string;
  canFocus?: boolean;
  text: string;
  error?: string;
}

const STATUS_KEYS: Record<string, StringKey> = {
  working: 'working',
  blocked: 'waiting',
  done: 'done',
  idle: 'idle',
  unknown: 'unknown',
};

interface AgentDetailPanelProps {
  officeState: OfficeState;
}

/** Selection lives on the office engine (canvas clicks mutate it directly), so
 *  the panel samples it instead of relying on React state. */
function useSelectedAgentId(officeState: OfficeState): number | null {
  const [selected, setSelected] = useState<number | null>(officeState.selectedAgentId);
  useEffect(() => {
    const timer = setInterval(() => setSelected(officeState.selectedAgentId), 150);
    return () => clearInterval(timer);
  }, [officeState]);
  return selected;
}

/**
 * Agents HQ: side panel for the selected agent — project, session title,
 * status and its latest output. Read-only: nothing here sends input to an
 * agent. When the source supports it, a button brings the agent's terminal
 * to the front.
 */
export function AgentDetailPanel({ officeState }: AgentDetailPanelProps) {
  useHqSettings();
  const agentId = useSelectedAgentId(officeState);
  const [detail, setDetail] = useState<AgentDetail | null>(null);
  const [focusState, setFocusState] = useState<'idle' | 'sent' | 'error'>('idle');
  const outputRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    if (agentId === null || !officeState.characters.has(agentId)) return;
    setDetail(null);
    setFocusState('idle');
    const unsubscribe = transport.onMessage((raw) => {
      const msg = raw as unknown as Record<string, unknown>;
      if (msg.type === 'hubAgentDetail' && msg.id === agentId) {
        setDetail(msg as unknown as AgentDetail);
      } else if (msg.type === 'hubFocusResult' && msg.id === agentId) {
        setFocusState(msg.ok ? 'sent' : 'error');
      }
    });
    const request = () => transport.send({ type: 'hubReadAgent', id: agentId } as never);
    request();
    const timer = setInterval(request, OUTPUT_REFRESH_MS);
    return () => {
      unsubscribe();
      clearInterval(timer);
    };
  }, [agentId, officeState]);

  // Keep the newest output in view, like a terminal.
  useEffect(() => {
    const el = outputRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [detail?.text]);

  if (agentId === null) return null;
  if (!officeState.characters.has(agentId)) return null;

  const statusKey = detail ? STATUS_KEYS[detail.status] : undefined;
  const statusLabel = detail ? (statusKey ? t(statusKey) : detail.status) : '…';

  return (
    <div
      className="absolute top-8 right-8 bottom-80 flex flex-col pixel-panel p-10 gap-8"
      style={{ width: 'min(560px, calc(100vw - 32px))', zIndex: 60 }}
      data-testid="agent-detail-panel"
    >
      <div className="flex items-start justify-between gap-8">
        <div className="flex flex-col gap-2 overflow-hidden">
          <span className="text-sm text-text-muted overflow-hidden text-ellipsis whitespace-nowrap">
            {detail ? [detail.workspace, detail.kind].filter(Boolean).join(' · ') : ''}
          </span>
          <span className="text-lg overflow-hidden text-ellipsis whitespace-nowrap">
            {detail?.title || 'Agent'}
          </span>
          <span className="text-sm">{statusLabel}</span>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            officeState.selectedAgentId = null;
          }}
          aria-label={t('close')}
        >
          x
        </Button>
      </div>
      <pre
        ref={outputRef}
        className="flex-1 overflow-auto m-0 p-8 bg-bg-dark text-xs whitespace-pre-wrap break-words"
        style={{ fontFamily: 'ui-monospace, Menlo, monospace', lineHeight: 1.35 }}
      >
        {detail?.error ? t('readFailed', { error: detail.error }) : (detail?.text ?? t('loading'))}
      </pre>
      <div className="flex items-center gap-8">
        {detail?.canFocus ? (
          <>
            <Button
              variant="accent"
              size="md"
              onClick={() => {
                setFocusState('idle');
                transport.send({ type: 'hubFocusAgent', id: agentId } as never);
              }}
            >
              {t('jumpToTerminal')}
            </Button>
            {focusState === 'sent' && <span className="text-sm text-text-muted">{t('jumped')}</span>}
            {focusState === 'error' && (
              <span className="text-sm" style={{ color: 'var(--color-danger)' }}>
                {t('jumpFailed')}
              </span>
            )}
          </>
        ) : (
          <span className="text-sm text-text-muted">{t('readOnlyNote')}</span>
        )}
      </div>
    </div>
  );
}
