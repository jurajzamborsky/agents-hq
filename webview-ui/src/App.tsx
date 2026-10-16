import { useCallback, useEffect, useRef, useState } from 'react';

import { AgentDetailPanel } from './components/AgentDetailPanel.js';
import { AgentsHud } from './components/AgentsHud.js';
import { ConnectionIndicator } from './components/ConnectionIndicator.js';
import { HqSettings } from './components/HqSettings.js';
import { Modal } from './components/ui/Modal.js';
import { useEditorActions } from './hooks/useEditorActions.js';
import { useExtensionMessages } from './hooks/useExtensionMessages.js';
import { BONUS_ROUND_URL, CONTACT_EMAIL, signTitle, t, useHqSettings } from './hq/i18n.js';
import { OfficeCanvas } from './office/components/OfficeCanvas.js';
import { EditorState } from './office/editor/editorState.js';
import { OfficeState } from './office/engine/officeState.js';
import { Office3D } from './office3d/Office3D.js';
import { ISO_DURATION, tourEnabled, tourWaits } from './office3d/tour.js';
import { isBrowserRuntime } from './runtime.js';
import { transport } from './transport/index.js';

// Game state lives outside React — updated imperatively by message handlers.
const officeStateRef = { current: null as OfficeState | null };
const editorState = new EditorState();

function getOfficeState(): OfficeState {
  if (!officeStateRef.current) officeStateRef.current = new OfficeState();
  return officeStateRef.current;
}

type OfficeView = 'iso' | 'pov';
const TOUR = tourEnabled();
const VIEW_KEY = 'agents-hq-view';

function loadView(): OfficeView {
  try {
    return localStorage.getItem(VIEW_KEY) === 'pov' ? 'pov' : 'iso';
  } catch {
    return 'iso';
  }
}

/**
 * Agents HQ: the office as a voxel 3D diorama (top-down) or first-person POV.
 * The 2D engine underneath still runs the simulation (seats, paths, breaks);
 * its canvas sits hidden under the 3D view.
 */
function App() {
  useEffect(() => {
    // Vite dev mode without a server: mock messages for UI work.
    if (isBrowserRuntime && import.meta.env.DEV) {
      void import('./browserMock.js').then(({ dispatchMockMessages }) => dispatchMockMessages());
    }
  }, []);

  const hq = useHqSettings();
  const editor = useEditorActions(getOfficeState, editorState);
  const isEditDirty = useCallback(() => false, []);
  const { agents, agentTools, layoutReady, alwaysShowLabels } = useExtensionMessages(
    getOfficeState,
    editor.setLastSavedLayout,
    isEditDirty,
  );

  const [view, setViewState] = useState<OfficeView>(TOUR ? 'iso' : loadView);
  // Guided tour (?tour=1): starts once the office is ready, flies over it, then walks in POV.
  const [tourStart, setTourStart] = useState<number | null>(null);
  useEffect(() => {
    if (!TOUR || !layoutReady || tourStart !== null) return;
    if (!tourWaits()) {
      setTourStart(Date.now());
      return;
    }
    const start = () => setTourStart(Date.now());
    window.addEventListener('hq-start-tour', start, { once: true });
    return () => window.removeEventListener('hq-start-tour', start);
  }, [layoutReady, tourStart]);
  useEffect(() => {
    if (tourStart === null) return;
    const timer = setTimeout(() => setViewState('pov'), ISO_DURATION * 1000);
    return () => clearTimeout(timer);
  }, [tourStart]);
  const setView = (next: OfficeView) => {
    setViewState(next);
    try {
      localStorage.setItem(VIEW_KEY, next);
    } catch {
      // storage blocked: the choice still works for this session
    }
  };

  const [showLabels, setShowLabels] = useState(alwaysShowLabels);
  useEffect(() => setShowLabels(alwaysShowLabels), [alwaysShowLabels]);
  const toggleLabels = useCallback(() => {
    setShowLabels((prev) => {
      transport.send({ type: 'setAlwaysShowLabels', enabled: !prev });
      return !prev;
    });
  }, []);

  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isCustomOpen, setIsCustomOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const officeState = getOfficeState();

  useEffect(() => {
    document.title = signTitle(hq.companyName);
    document.documentElement.lang = hq.language;
  }, [hq.companyName, hq.language]);

  if (!layoutReady) {
    return <div className="w-full h-full flex items-center justify-center">{t('loadingOffice')}</div>;
  }

  const visibleAgents = agents.filter((id) => !officeState.characters.get(id)?.isSubagent);

  return (
    <div ref={containerRef} className="w-full h-full relative overflow-hidden">
      {/* Runs the simulation loop; covered by the 3D view. */}
      <OfficeCanvas
        officeState={officeState}
        onClick={() => {}}
        isEditMode={false}
        editorState={editorState}
        onEditorTileAction={editor.handleEditorTileAction}
        onEditorEraseAction={editor.handleEditorEraseAction}
        onEditorSelectionChange={editor.handleEditorSelectionChange}
        onDeleteSelected={editor.handleDeleteSelected}
        onRotateSelected={editor.handleRotateSelected}
        onDragMove={editor.handleDragMove}
        editorTick={editor.editorTick}
        zoom={editor.zoom}
        onZoomChange={editor.handleZoomChange}
        panRef={editor.panRef}
        showAreas={false}
        activeAreaLabel={null}
      />

      <Office3D
        officeState={officeState}
        agentTools={agentTools}
        alwaysShowLabels={showLabels}
        mode={view}
        tourStart={tourStart}
      />

      {/* Lobby plaque */}
      <div
        className="absolute top-8 left-8 pixel-panel px-10 py-2 pointer-events-none flex flex-col"
        style={{ zIndex: 50, lineHeight: 1.1 }}
      >
        <span className="text-lg font-extrabold" style={{ letterSpacing: '-0.02em' }}>{signTitle(hq.companyName)}</span>
        <span className="text-xs font-semibold" style={{ color: '#c6f05a' }}>{t('by')}</span>
      </div>

      {/* View switch */}
      <div className="absolute top-8 left-1/2 -translate-x-1/2 flex pixel-panel" style={{ zIndex: 50 }}>
        {(['iso', 'pov'] as const).map((v) => (
          <button
            key={v}
            onClick={() => setView(v)}
            className={`px-16 py-4 text-base font-bold cursor-pointer border-none ${view === v ? 'on-accent' : 'text-inherit'}`}
            style={{ background: view === v ? 'var(--color-accent)' : 'transparent', borderRadius: 3 }}
          >
            {v === 'pov' ? t('viewPov') : t('view3d')}
          </button>
        ))}
      </div>

      {visibleAgents.length === 0 && (
        <div
          className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 pixel-panel px-16 py-10 text-center pointer-events-none"
          style={{ zIndex: 40, maxWidth: 'min(460px, calc(100vw - 32px))', whiteSpace: 'pre-line', textWrap: 'pretty' }}
        >
          {t('empty')}
        </div>
      )}

      {/* Settings */}
      {!TOUR && (
      <button
        onClick={() => setIsSettingsOpen(true)}
        className="absolute bottom-8 left-8 pixel-panel px-12 py-6 cursor-pointer text-inherit text-sm font-semibold"
        style={{ zIndex: 50 }}
        aria-label={t('settings')}
      >
        ⚙ {t('settings')}
      </button>
      )}

      {/* Bonus Round: custom office offer + badge */}
      <div className="absolute bottom-8 right-8 flex items-center gap-8" style={{ zIndex: 50 }}>
        <button
          onClick={() => setIsCustomOpen(true)}
          className="pixel-panel px-12 py-6 cursor-pointer text-sm font-semibold on-accent"
          style={{ background: 'var(--color-accent)', borderColor: 'var(--color-accent)' }}
        >
          {t('customChip')} →
        </button>
        <a
          href={BONUS_ROUND_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="pixel-panel px-12 py-6 no-underline text-inherit hover:brightness-125 flex items-center gap-8 text-sm"
        >
          <span className="text-text-muted">{t('builtWith')}</span>
          <img src="brand/bonus-round-logo-white.svg" alt="Bonus Round" height={14} style={{ height: 14 }} />
        </a>
      </div>

      <Modal isOpen={isCustomOpen} onClose={() => setIsCustomOpen(false)} title={t('customTitle')} zIndex={70}>
        <div className="flex flex-col gap-12 px-10 pb-10" style={{ width: 'min(500px, calc(100vw - 48px))' }}>
          <p className="m-0" style={{ whiteSpace: 'pre-line', textWrap: 'pretty', lineHeight: 1.5 }}>
            {t('customBody')}
          </p>
          <a
            href={`mailto:${CONTACT_EMAIL}?subject=Agents%20HQ%20na%20mieru`}
            className="pixel-panel px-14 py-8 text-center no-underline font-bold on-accent"
            style={{ background: 'var(--color-accent)', borderColor: 'var(--color-accent)' }}
          >
            {t('customButton')} · {CONTACT_EMAIL}
          </a>
        </div>
      </Modal>

      <ConnectionIndicator />

      <HqSettings
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        alwaysShowLabels={showLabels}
        onToggleLabels={toggleLabels}
      />

      {!TOUR && <AgentsHud officeState={officeState} />}

      <AgentDetailPanel officeState={officeState} />
    </div>
  );
}

export default App;
