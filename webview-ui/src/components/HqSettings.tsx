import { useEffect, useState } from 'react';

import { CONTACT_EMAIL, type Language, t, useHqSettings } from '../hq/i18n.js';
import { isSoundEnabled, setSoundEnabled } from '../notificationSound.js';
import { transport } from '../transport/index.js';
import { Checkbox } from './ui/Checkbox.js';
import { Modal } from './ui/Modal.js';

interface HqSettingsProps {
  isOpen: boolean;
  onClose: () => void;
  alwaysShowLabels: boolean;
  onToggleLabels: () => void;
}

/** Agents HQ settings: company name on the lobby sign, language, sound, labels. */
export function HqSettings({ isOpen, onClose, alwaysShowLabels, onToggleLabels }: HqSettingsProps) {
  const { companyName, language } = useHqSettings();
  const [draft, setDraft] = useState(companyName);
  const [sound, setSound] = useState(isSoundEnabled());

  useEffect(() => {
    if (isOpen) {
      setDraft(companyName);
      setSound(isSoundEnabled());
    }
  }, [isOpen, companyName]);

  const saveCompany = () => {
    if (draft.trim() !== companyName) transport.send({ type: 'setCompanyName', name: draft } as never);
  };
  const setLanguage = (next: Language) => transport.send({ type: 'setLanguage', language: next } as never);

  return (
    <Modal
      isOpen={isOpen}
      onClose={() => {
        saveCompany();
        onClose();
      }}
      title={t('settings')}
      zIndex={70}
    >
      <div className="flex flex-col gap-10 px-10 pb-10" style={{ width: 'min(420px, calc(100vw - 48px))' }}>
        <label className="flex flex-col gap-4">
          <span>{t('companyLabel')}</span>
          <input
            value={draft}
            maxLength={40}
            placeholder={t('companyPlaceholder')}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={saveCompany}
            onKeyDown={(e) => {
              if (e.key === 'Enter') saveCompany();
            }}
            className="bg-bg-dark border-2 border-border rounded-[3px] px-10 py-6 text-base text-text outline-none focus:border-accent"
          />
          <span className="text-sm text-text-muted">{t('companyHint')}</span>
        </label>

        <div className="flex items-center justify-between">
          <span>{t('language')}</span>
          <div className="flex pixel-panel">
            {(['sk', 'en'] as const).map((lang) => (
              <button
                key={lang}
                onClick={() => setLanguage(lang)}
                className={`px-12 py-4 cursor-pointer border-none font-bold ${language === lang ? 'on-accent' : 'text-inherit'}`}
                style={{ background: language === lang ? 'var(--color-accent)' : 'transparent', borderRadius: 3 }}
              >
                {lang.toUpperCase()}
              </button>
            ))}
          </div>
        </div>

        <div className="flex flex-col">
          <Checkbox
            label={t('sound')}
            checked={sound}
            onChange={() => {
              const next = !sound;
              setSound(next);
              setSoundEnabled(next);
              transport.send({ type: 'setSoundEnabled', enabled: next });
            }}
            className="px-0"
          />
          <Checkbox label={t('labels')} checked={alwaysShowLabels} onChange={onToggleLabels} className="px-0" />
        </div>

        <p className="text-sm text-text-muted m-0" style={{ textWrap: 'pretty', whiteSpace: 'pre-line' }}>
          🔒 {t('readOnly')}
        </p>
        <p className="text-sm m-0" style={{ whiteSpace: 'pre-line' }}>
          {t('customBody')}
          <br />
          <a className="text-accent-bright" href={`mailto:${CONTACT_EMAIL}?subject=Agents%20HQ`}>
            {CONTACT_EMAIL}
          </a>
        </p>
      </div>
    </Modal>
  );
}
