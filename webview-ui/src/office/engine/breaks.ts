/**
 * Agents HQ: where agents go when they are not working.
 *
 * Priority, highest first (each one says something real about the agent):
 *  1. reception  — waiting for your approval / answer in a dialog (status blocked)
 *  2. desk       — working (handled by the regular FSM)
 *  3. phone      — finished, and you have not looked at the result yet (status done)
 *  4. gym/shower — just finished work that used subagents / a long work stretch
 *  5. nap        — idle for a long time (server flag)
 *  6. random     — coffee (+ chat at the kitchen tables), WC, game room
 *
 * This runs before the regular character FSM each frame and only steers it:
 * it starts walks (state WALK + path) and parks the character at the spot.
 */

import { getCatalogEntry } from '../layout/furnitureCatalog.js';
import { findPath } from '../layout/tileMap.js';
import type { BreakKind, BreakPose, BreakSpot, Character, OfficeLayout, TileType as TileTypeVal } from '../types.js';
import { CharacterState, Direction } from '../types.js';
import { type StringKey, t } from '../../hq/i18n.js';

/** Idle seconds between "should I take a break?" checks. */
const BREAK_CHECK_MIN_SEC = 25;
const BREAK_CHECK_MAX_SEC = 70;
const BREAK_CHANCE = 0.55;
const CHAT_AFTER_COFFEE_CHANCE = 0.7;
/** Seconds at the spot; open-ended ones end when their signal ends. */
const STAY: Record<BreakKind, [number, number]> = {
  reception: [1e9, 1e9],
  phone: [1e9, 1e9],
  nap: [1e9, 1e9],
  coffee: [6, 10],
  chat: [20, 45],
  wc: [8, 15],
  play: [25, 50],
  gym: [60, 120],
  shower: [30, 60],
};
/** Keeps the regular FSM from wandering off while parked at a spot. */
const PARKED = 1e9;
const TABLE_TYPES = new Set(['SMALL_TABLE_FRONT', 'SMALL_TABLE_SIDE', 'TABLE_FRONT', 'COFFEE_TABLE']);

export type Amenities = Record<BreakKind, BreakSpot[]> & { kitchenArea: string | null };

export function emptyAmenities(): Amenities {
  return {
    reception: [],
    phone: [],
    nap: [],
    coffee: [],
    chat: [],
    wc: [],
    play: [],
    gym: [],
    shower: [],
    kitchenArea: null,
  };
}

const BREAK_ACTIVITY_KEYS: Record<BreakKind, StringKey> = {
  reception: 'breakReception',
  phone: 'breakPhone',
  nap: 'breakNap',
  coffee: 'breakCoffee',
  chat: 'breakChat',
  wc: 'breakWc',
  play: 'breakPlay',
  gym: 'breakGym',
  shower: 'breakShower',
};

/** Label shown instead of "Idle" while on a break, in the UI language. */
export function breakActivity(kind: BreakKind): string {
  return t(BREAK_ACTIVITY_KEYS[kind]);
}

/** Little icon next to the head while on a break. */
export const BREAK_ICON: Partial<Record<BreakKind, string>> = {
  reception: '🛎️',
  phone: '📞',
  coffee: '☕',
  wc: '🚻',
  play: '🏓',
  gym: '💪',
  shower: '🚿',
};

/** Breaks where agents chat about their work when two or more are there. */
export const SOCIAL_BREAKS = new Set<BreakKind>(['coffee', 'chat', 'play']);

const key = (col: number, row: number) => `${col},${row}`;

const TURN_MS = 5000;
const SPEAK_MS = 4200;

/**
 * Who is talking right now: in every room with two or more agents on a social
 * break, they take turns saying what they work on.
 */
export function currentSpeakers(chars: Iterable<Character>, layout: OfficeLayout, now: number): Set<number> {
  const byRoom = new Map<string, Character[]>();
  for (const ch of chars) {
    const br = ch.breakState;
    if (ch.isSubagent || !br?.arrived || !SOCIAL_BREAKS.has(br.kind)) continue;
    const room = layout.areaTiles?.[br.spot.row * layout.cols + br.spot.col] ?? br.kind;
    const list = byRoom.get(room) ?? [];
    list.push(ch);
    byRoom.set(room, list);
  }
  const speakers = new Set<number>();
  if (now % TURN_MS >= SPEAK_MS) return speakers;
  for (const list of byRoom.values()) {
    if (list.length < 2) continue;
    list.sort((a, b) => a.id - b.id);
    speakers.add(list[Math.floor(now / TURN_MS) % list.length].id);
  }
  return speakers;
}

/** Text next to an agent on a break: speech while it is its turn, else an icon. */
export function breakBubble(
  ch: Character,
  speaking: boolean,
  title: string | undefined,
  now: number,
  maxLen: number,
): { text: string; speech: boolean } | null {
  const br = ch.breakState;
  if (!br?.arrived) return null;
  if (br.kind === 'nap') return { text: 'Z'.repeat(1 + (Math.floor(now / 700 + ch.id) % 3)) + '…', speech: false };
  if (speaking) {
    let text = title ? t('talkTitle', { title }) : t('talkProject', { project: ch.folderName ?? '?' });
    if (text.length > maxLen) text = `${text.slice(0, maxLen - 1)}…`;
    return { text, speech: true };
  }
  if (br.kind === 'chat') return null;
  const icon = BREAK_ICON[br.kind];
  return icon ? { text: icon, speech: false } : null;
}

export function buildAmenities(
  layout: OfficeLayout,
  walkable: Array<{ col: number; row: number }>,
): Amenities {
  const a = emptyAmenities();
  const walkableSet = new Set(walkable.map((t) => key(t.col, t.row)));
  const areaAt = (col: number, row: number): string | null =>
    layout.areaTiles?.[row * layout.cols + col] ?? null;
  const add = (kind: BreakKind, col: number, row: number, dir: Direction, pose: BreakPose, needWalkable = false) => {
    if (needWalkable && !walkableSet.has(key(col, row))) return;
    a[kind].push({ col, row, dir, pose, takenBy: null });
  };

  const tableTiles = new Set<string>();
  for (const item of layout.furniture) {
    const entry = getCatalogEntry(item.type);
    if (!entry) continue;
    const { col, row } = item;
    const w = entry.footprintW;
    const h = entry.footprintH;
    switch (item.type) {
      case 'COFFEE_MACHINE':
        add('coffee', col, row + h, Direction.UP, 'stand', true);
        break;
      case 'BED':
        add('nap', col, row + h - 1, Direction.DOWN, 'lie');
        break;
      case 'WAITING_CHAIR':
        add('reception', col, row, Direction.DOWN, 'sit');
        break;
      case 'PHONE_BOOTH':
        add('phone', col, row + h - 1, Direction.UP, 'phone');
        break;
      case 'TOILET':
        add('wc', col, row, Direction.DOWN, 'sit');
        break;
      case 'SHOWER':
        add('shower', col, row + h - 1, Direction.DOWN, 'shower');
        break;
      case 'TREADMILL':
        add('gym', col, row + h - 1, Direction.UP, 'run');
        break;
      case 'WEIGHT_RACK':
        for (let dc = 0; dc < w; dc++) add('gym', col + dc, row + h, Direction.UP, 'lift', true);
        break;
      case 'YOGA_MAT':
        add('gym', col, row + h - 1, Direction.DOWN, 'sit');
        break;
      case 'PINGPONG_TABLE':
        add('play', col - 1, row, Direction.RIGHT, 'play', true);
        add('play', col + w, row + h - 1, Direction.LEFT, 'play', true);
        break;
      case 'FOOSBALL':
        add('play', col, row - 1, Direction.DOWN, 'play', true);
        add('play', col + w - 1, row + h, Direction.UP, 'play', true);
        break;
      case 'BEAN_BAG':
        add('play', col, row, Direction.DOWN, 'sit');
        break;
      default:
        if (TABLE_TYPES.has(item.type)) {
          for (let dr = 0; dr < h; dr++) {
            for (let dc = 0; dc < w; dc++) tableTiles.add(key(col + dc, row + dr));
          }
        }
    }
  }

  a.kitchenArea = a.coffee.length > 0 ? areaAt(a.coffee[0].col, a.coffee[0].row) : null;
  if (a.kitchenArea) {
    const sides: Array<{ dc: number; dr: number; dir: Direction }> = [
      { dc: 0, dr: -1, dir: Direction.UP },
      { dc: 0, dr: 1, dir: Direction.DOWN },
      { dc: -1, dr: 0, dir: Direction.LEFT },
      { dc: 1, dr: 0, dir: Direction.RIGHT },
    ];
    for (const t of walkable) {
      if (areaAt(t.col, t.row) !== a.kitchenArea) continue;
      const side = sides.find((s) => tableTiles.has(key(t.col + s.dc, t.row + s.dr)));
      if (side) a.chat.push({ col: t.col, row: t.row, dir: side.dir, pose: 'stand', takenBy: null });
    }
  }
  return a;
}

/** Free a character's spot (on removal, wake-up, or the end of a break). */
export function releaseBreak(ch: Character): void {
  if (ch.breakState && ch.breakState.spot.takenBy === ch.id) ch.breakState.spot.takenBy = null;
  ch.breakState = null;
}

/** Furniture tiles are blocked; unblock the target while pathing to it. */
function pathTo(
  ch: Character,
  spot: BreakSpot,
  tileMap: TileTypeVal[][],
  blockedTiles: Set<string>,
): Array<{ col: number; row: number }> | null {
  const k = key(spot.col, spot.row);
  const wasBlocked = blockedTiles.delete(k);
  try {
    if (ch.tileCol === spot.col && ch.tileRow === spot.row) return [];
    const path = findPath(ch.tileCol, ch.tileRow, spot.col, spot.row, tileMap, blockedTiles);
    return path.length > 0 ? path : null;
  } finally {
    if (wasBlocked) blockedTiles.add(k);
  }
}

function startBreak(
  ch: Character,
  kind: BreakKind,
  amenities: Amenities,
  tileMap: TileTypeVal[][],
  blockedTiles: Set<string>,
): boolean {
  const free = amenities[kind].filter((s) => s.takenBy === null);
  // Try a few random free spots; take the first one we can walk to.
  for (let i = 0; i < Math.min(free.length, 6); i++) {
    const spot = free.splice(Math.floor(Math.random() * free.length), 1)[0];
    const path = pathTo(ch, spot, tileMap, blockedTiles);
    if (!path) continue;
    releaseBreak(ch);
    spot.takenBy = ch.id;
    const [min, max] = STAY[kind];
    ch.breakState = { kind, spot, arrived: false, timer: rand(min, max) };
    ch.path = path;
    ch.moveProgress = 0;
    ch.state = path.length > 0 ? CharacterState.WALK : CharacterState.IDLE;
    ch.seatTimer = 0;
    ch.frame = 0;
    ch.frameTimer = 0;
    return true;
  }
  return false;
}

function headHome(ch: Character): void {
  releaseBreak(ch);
  if (ch.state === CharacterState.TYPE) ch.state = CharacterState.IDLE;
  ch.seatTimer = 0;
  // Make the regular FSM walk back to the desk on its next wander tick.
  ch.wanderCount = ch.wanderLimit;
  ch.wanderTimer = 0.3;
  ch.breakCooldown = rand(BREAK_CHECK_MIN_SEC, BREAK_CHECK_MAX_SEC);
}

export interface BreakSignals {
  /** Raw terminal status: idle | working | blocked | done | unknown. */
  status: string | undefined;
  /** Server-sent reward after finishing work, consumed once. */
  perk: 'gym' | 'shower' | undefined;
  consumePerk: () => void;
}

/** Runs before updateCharacter. */
export function updateBreaks(
  ch: Character,
  dt: number,
  amenities: Amenities,
  tileMap: TileTypeVal[][],
  blockedTiles: Set<string>,
  signals: BreakSignals,
): void {
  if (ch.isSubagent) return;
  /** Be at (or walking to) a spot of this kind. False if none is free/reachable. */
  const want = (kind: BreakKind): boolean => {
    if (ch.breakState?.kind === kind) return true;
    return startBreak(ch, kind, amenities, tileMap, blockedTiles);
  };

  // 1. Waiting for your approval: wait at the reception, not at the desk.
  if (signals.status === 'blocked') {
    ch.isActive = false; // keep the regular FSM from walking back to the desk
    if (want('reception')) {
      park(ch, dt);
      return;
    }
  } else if (ch.breakState?.kind === 'reception') {
    headHome(ch);
  }

  // 2. Working: the regular FSM takes the agent to its desk.
  if (ch.isActive) {
    if (ch.breakState) {
      releaseBreak(ch);
      if (ch.state === CharacterState.TYPE) ch.state = CharacterState.IDLE;
      ch.seatTimer = 0;
    }
    return;
  }

  // 3. Unseen result: wait in a phone booth until you look at it.
  if (signals.status === 'done') {
    if (want('phone')) {
      park(ch, dt);
      return;
    }
  } else if (ch.breakState?.kind === 'phone') {
    headHome(ch);
    return;
  }

  // 4. Reward after work: gym (used subagents) or shower (long stretch).
  if (signals.perk) {
    const perk = signals.perk;
    signals.consumePerk();
    if (startBreak(ch, perk, amenities, tileMap, blockedTiles)) return;
  }

  // 5. Long idle: nap (woken up as soon as the flag drops).
  if (ch.breakState?.kind === 'nap' && !ch.napping) {
    headHome(ch);
    return;
  }
  if (ch.napping && ch.breakState?.kind !== 'nap' && ch.state !== CharacterState.WALK) {
    if (startBreak(ch, 'nap', amenities, tileMap, blockedTiles)) return;
  }

  const br = ch.breakState;
  if (br) {
    if (!park(ch, dt)) return;
    if (br.timer > 0) return; // timed breaks end here
    if (
      br.kind === 'coffee' &&
      Math.random() < CHAT_AFTER_COFFEE_CHANCE &&
      startBreak(ch, 'chat', amenities, tileMap, blockedTiles)
    ) {
      return;
    }
    headHome(ch);
    return;
  }

  // 6. Idle and free: now and then take a break.
  if (ch.state !== CharacterState.IDLE && ch.state !== CharacterState.TYPE) return;
  ch.breakCooldown = (ch.breakCooldown ?? rand(BREAK_CHECK_MIN_SEC, BREAK_CHECK_MAX_SEC)) - dt;
  if (ch.breakCooldown > 0) return;
  ch.breakCooldown = rand(BREAK_CHECK_MIN_SEC, BREAK_CHECK_MAX_SEC);
  if (Math.random() >= BREAK_CHANCE) return;
  const roll = Math.random();
  const kind: BreakKind = roll < 0.55 ? 'coffee' : roll < 0.75 ? 'wc' : 'play';
  startBreak(ch, kind, amenities, tileMap, blockedTiles);
}

/**
 * Walk-to-spot bookkeeping and parking. Returns true once the character is at
 * its spot (timer running), false while still walking or after giving up.
 */
function park(ch: Character, dt: number): boolean {
  const br = ch.breakState;
  if (!br) return false;
  if (!br.arrived) {
    if (ch.state === CharacterState.WALK) return false;
    if (ch.tileCol !== br.spot.col || ch.tileRow !== br.spot.row) {
      headHome(ch); // path got interrupted; give up on this break
      return false;
    }
    br.arrived = true;
    ch.frame = 0;
  }
  ch.dir = br.spot.dir;
  if (br.spot.pose === 'sit' || br.spot.pose === 'lie') {
    ch.state = CharacterState.TYPE; // seated pose
    ch.seatTimer = PARKED;
    ch.frame = 0;
    ch.frameTimer = 0;
  } else {
    if (ch.state === CharacterState.TYPE) ch.state = CharacterState.IDLE;
    ch.wanderTimer = PARKED;
  }
  br.timer -= dt;
  return true;
}

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}
