/**
 * Agents HQ: UI language (SK default, EN) and the company name on the lobby
 * sign. Both come from the server's `hqSettings` message and live in this
 * tiny store, so canvas code and React components read the same values.
 */

import { useSyncExternalStore } from 'react';

export type Language = 'sk' | 'en';

const STRINGS = {
  sk: {
    product: 'Agents HQ',
    by: 'by Bonus Round',
    builtBy: 'Postavené v Bonus Round',
    view3d: '3D',
    viewPov: 'POV',
    settings: 'Nastavenia',
    close: 'Zavrieť',
    companyLabel: 'Názov tvojej firmy',
    companyHint: 'Zobrazí sa na tabuli v lobby.',
    companyPlaceholder: 'napr. Donio',
    language: 'Jazyk',
    sound: 'Zvuk, keď agent dokončí prácu',
    labels: 'Vždy ukazovať menovky agentov',
    readOnly: 'Agents HQ iba číta, ktoré sessions bežia na tvojom počítači.\nNič neprepisuje a nič neposiela von.',
    customChip: 'Office na mieru pre tvoju firmu',
    customTitle: 'Agents HQ na mieru',
    customBody: 'Chceš office pre svoju firmu?\nVlastné miestnosti, vizuál postavičiek aj pracovné benefity.\nNapíš mi a postavíme ho spolu.',
    customButton: 'Napíš mi',
    builtWith: 'Postavené v',
    // agent states
    working: 'Pracuje',
    waiting: 'Čaká na teba',
    done: 'Hotovo',
    idle: 'Nečinný',
    unknown: 'Neznámy stav',
    workingDefault: 'Pracuje…',
    // breaks
    breakReception: 'Čaká na teba',
    breakPhone: 'Má pre teba výsledok',
    breakNap: 'Spí',
    breakCoffee: 'Na káve',
    breakChat: 'V kuchyni',
    breakWc: 'Na WC',
    breakPlay: 'V herni',
    breakGym: 'V posilke',
    breakShower: 'V sprche',
    talkTitle: 'Robím na: {title}',
    talkProject: 'Som z {project}',
    // detail panel
    loading: 'Načítavam…',
    readFailed: 'Výstup sa nepodarilo načítať: {error}',
    jumpToTerminal: 'Prejdi do terminálu',
    jumped: 'Prepnuté v termináli',
    jumpFailed: 'Prepnutie zlyhalo',
    readOnlyNote: 'Iba na čítanie. Agentovi odpíšeš v jeho termináli.',
    // POV + HUD
    povEnter: 'Klikni a vstúp do officu',
    povHelp: 'WASD / šípky chôdza · Shift beh · myš rozhliadanie · E alebo klik otvorí agenta · Esc kurzor',
    hudWaiting: '{n} čaká na teba',
    hudWorking: '{n} pracuje',
    empty: 'Zatiaľ tu nikto nepracuje.\nSpusti Claude Code alebo Codex v termináli a agent sa tu do pár sekúnd objaví.',
    loadingOffice: 'Otváram office…',
  },
  en: {
    product: 'Agents HQ',
    by: 'by Bonus Round',
    builtBy: 'Built by Bonus Round',
    view3d: '3D',
    viewPov: 'POV',
    settings: 'Settings',
    close: 'Close',
    companyLabel: 'Your company name',
    companyHint: 'Shown on the lobby sign.',
    companyPlaceholder: 'e.g. Acme',
    language: 'Language',
    sound: 'Sound when an agent finishes',
    labels: 'Always show agent name tags',
    readOnly: 'Agents HQ only reads which sessions run on your computer.\nIt changes nothing and sends nothing out.',
    customChip: 'A custom office for your company',
    customTitle: 'Agents HQ, made to measure',
    customBody: 'Want an office for your company?\nYour own rooms, character look and workplace perks.\nDrop me a line and we build it together.',
    customButton: 'Write to me',
    builtWith: 'Built by',
    working: 'Working',
    waiting: 'Waiting for you',
    done: 'Done',
    idle: 'Idle',
    unknown: 'Unknown',
    workingDefault: 'Working…',
    breakReception: 'Waiting for you',
    breakPhone: 'Has a result for you',
    breakNap: 'Sleeping',
    breakCoffee: 'Coffee break',
    breakChat: 'In the kitchen',
    breakWc: 'In the restroom',
    breakPlay: 'In the game room',
    breakGym: 'At the gym',
    breakShower: 'In the shower',
    talkTitle: 'Working on: {title}',
    talkProject: "I'm from {project}",
    loading: 'Loading…',
    readFailed: 'Could not load the output: {error}',
    jumpToTerminal: 'Go to terminal',
    jumped: 'Switched in the terminal',
    jumpFailed: 'Switch failed',
    readOnlyNote: 'Read-only. Reply to the agent in its terminal.',
    povEnter: 'Click to enter the office',
    povHelp: 'WASD / arrows walk · Shift run · mouse look · E or click opens an agent · Esc cursor',
    hudWaiting: '{n} waiting for you',
    hudWorking: '{n} working',
    empty: 'Nobody works here yet.\nStart Claude Code or Codex in a terminal and the agent shows up within seconds.',
    loadingOffice: 'Opening the office…',
  },
} as const;

export type StringKey = keyof (typeof STRINGS)['sk'];

/** Shared room names come from the server in Slovak; English names for display. */
const ROOM_NAMES_EN: Record<string, string> = {
  '🛎️ Recepcia': '🛎️ Reception',
  '🏓 Herňa': '🏓 Game room',
  '☕ Kuchyňa': '☕ Kitchen',
  '💤 Spáľňa': '💤 Nap room',
  '🚿 Sprchy & WC': '🚿 Showers & WC',
  '🏋️ Posilňovňa': '🏋️ Gym',
  '🗂️ Ďalšie projekty': '🗂️ Other projects',
};

interface HqState {
  language: Language;
  companyName: string;
}

let state: HqState = { language: 'sk', companyName: '' };
const listeners = new Set<() => void>();

export function setHqSettings(next: Partial<HqState>): void {
  state = {
    language: next.language === 'en' || next.language === 'sk' ? next.language : state.language,
    companyName: typeof next.companyName === 'string' ? next.companyName : state.companyName,
  };
  for (const l of listeners) l();
}

export function getHqSettings(): HqState {
  return state;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** React hook: re-renders when the language or company name changes. */
export function useHqSettings(): HqState {
  return useSyncExternalStore(subscribe, getHqSettings);
}

/** Subscribe outside React (canvas / three.js code). */
export const onHqSettings = subscribe;

export function t(key: StringKey, params?: Record<string, string | number>): string {
  let text: string = STRINGS[state.language][key];
  if (params) for (const [k, v] of Object.entries(params)) text = text.replace(`{${k}}`, String(v));
  return text;
}

export function roomName(label: string): string {
  return state.language === 'en' ? (ROOM_NAMES_EN[label] ?? label) : label;
}

/** Status text the server sends as a key ("hq:working") → display text. */
export function statusText(status: string): string {
  if (status === 'hq:waiting') return t('waiting');
  if (status === 'hq:working') return t('workingDefault');
  return status;
}

/** "<company> Agents HQ", or just "Agents HQ". */
export function signTitle(companyName = state.companyName): string {
  return companyName ? `${companyName} ${t('product')}` : t('product');
}

export const BONUS_ROUND_URL = 'https://bonusround.sk/agents-hq?utm_source=agents-hq&utm_medium=app';
export const CONTACT_EMAIL = 'ahoj@bonusround.sk';
