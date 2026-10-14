/**
 * Agents HQ: project rooms.
 *
 * Every project an agent works in gets its own room, in the order they show
 * up, up to MAX_PROJECT_ROOMS; later projects share an overflow room. Rooms
 * are never taken away while the server runs, so nobody's desk moves.
 * The office layout is generated from Pixel Agents' bundled default office:
 * each room is a full copy of it (work room + lounge), tinted per project and
 * painted as an Area, so the existing seat picker keeps agents in their room.
 * A corridor between the two columns links every room. Shared rooms, top to
 * bottom: reception (with phone booths) and game room at the entrance, the
 * project rooms, kitchen and napping room, then showers/WC and the gym.
 */

export interface RoomDefinition {
  /** Area label, also printed on the door sign. */
  label: string;
  /** Area overlay color, #rrggbb. */
  color: string;
  /** Lounge floor hue (0-360) so rooms are easy to tell apart. */
  hue: number;
}

const ROOM_PALETTE: Array<{ emoji: string; color: string; hue: number }> = [
  { emoji: '🟧', color: '#ff8a3d', hue: 25 },
  { emoji: '🟦', color: '#3e63dd', hue: 220 },
  { emoji: '🟩', color: '#46a758', hue: 130 },
  { emoji: '🟥', color: '#e5484d', hue: 355 },
  { emoji: '🟪', color: '#8e4ec6', hue: 280 },
  { emoji: '🟨', color: '#f5a524', hue: 45 },
  { emoji: '🟫', color: '#a1662f', hue: 30 },
  { emoji: '🟩', color: '#12a594', hue: 170 },
  { emoji: '🟪', color: '#d6409f', hue: 320 },
  { emoji: '🟦', color: '#0090ff', hue: 200 },
];
export const MAX_PROJECT_ROOMS = ROOM_PALETTE.length;
export const OVERFLOW_LABEL = '🗂️ Ďalšie projekty';

export class RoomRegistry {
  readonly rooms: RoomDefinition[] = [];
  private readonly byProject = new Map<string, string>();

  /** The room label for a project; `added` is true when a new room had to be built. */
  roomFor(project: string): { label: string; added: boolean } {
    const known = this.byProject.get(project);
    if (known) return { label: known, added: false };
    let added = false;
    let label: string;
    if (this.rooms.length < MAX_PROJECT_ROOMS) {
      const look = ROOM_PALETTE[this.rooms.length];
      // Folders that already start with an emoji keep it; the rest get a color square.
      label = /^[\p{L}\p{N}~?]/u.test(project) ? `${look.emoji} ${project}` : project;
      this.rooms.push({ label, color: look.color, hue: look.hue });
      added = true;
    } else {
      label = OVERFLOW_LABEL;
      if (!this.rooms.some((r) => r.label === OVERFLOW_LABEL)) {
        this.rooms.push({ label, color: '#8b8d98', hue: 0 });
        added = true;
      }
    }
    this.byProject.set(project, label);
    return { label, added };
  }
}

// ── Layout generation ──────────────────────────────────────────

const WALL = 0;
const VOID = 255;
/** Floor tile types in the bundled default layout. */
const LOUNGE_FLOOR = 1;
const WOOD_FLOOR = 7;
const TILED_FLOOR = 9;
/** Template block cut from the default layout: rows 9-21 hold the office
 *  (row 9 = wall-mounted items above the top wall, row 21 = open bottom edge),
 *  cols 0-19 hold both rooms and their walls. */
const BLOCK_ROW_START = 9;
const BLOCK_ROWS = 13;
const BLOCK_COLS = 20;
const CORRIDOR_COLS = 3;
const ROOMS_PER_ROW = 2;
/** Block-local rows of the doors into the corridor. */
const LEFT_BLOCK_DOOR_ROWS = [8, 9];
const RIGHT_BLOCK_DOOR_ROWS = [5, 6];
const SHARED_DOOR_ROWS = [5, 6];
export const RECEPTION_LABEL = '🛎️ Recepcia';
export const GAME_LABEL = '🏓 Herňa';
export const KITCHEN_LABEL = '☕ Kuchyňa';
export const NAP_LABEL = '💤 Spáľňa';
export const BATH_LABEL = '🚿 Sprchy & WC';
export const GYM_LABEL = '🏋️ Posilňovňa';
export const GENERATED_LAYOUT_REVISION = 1002;

type Color = Record<string, number>;

interface TemplateLayout {
  cols: number;
  rows: number;
  tiles: number[];
  tileColors?: Array<Color | null>;
  furniture: Array<{ uid: string; type: string; col: number; row: number } & Record<string, unknown>>;
}

export function generateRoomsLayout(
  template: Record<string, unknown>,
  rooms: RoomDefinition[],
): Record<string, unknown> {
  const t = template as unknown as TemplateLayout;
  const templateColor = (type: number): Color | null => {
    const i = t.tiles.indexOf(type);
    return i >= 0 ? (t.tileColors?.[i] ?? null) : null;
  };
  const wallColor = templateColor(WALL);
  const woodColor = templateColor(WOOD_FLOOR);
  const tiledColor = templateColor(TILED_FLOOR);
  const loungeColor = templateColor(LOUNGE_FLOOR);

  const projectRows = Math.ceil(rooms.length / ROOMS_PER_ROW);
  const rightColStart = BLOCK_COLS + CORRIDOR_COLS;
  const cols = rightColStart + BLOCK_COLS + 1;
  // Row 0: reception + game room; then project rooms; then kitchen + nap; then bath + gym.
  const projectRow0 = BLOCK_ROWS;
  const kitchenRow = projectRow0 + projectRows * BLOCK_ROWS;
  const bathRow = kitchenRow + BLOCK_ROWS;
  const rows = bathRow + BLOCK_ROWS;

  const tiles: number[] = new Array(cols * rows).fill(VOID);
  const tileColors: Array<Color | null> = new Array(cols * rows).fill(null);
  const areaTiles: Array<string | null> = new Array(cols * rows).fill(null);
  const furniture: Array<Record<string, unknown>> = [];

  const set = (col: number, row: number, type: number, color: Color | null, area: string | null) => {
    const i = row * cols + col;
    tiles[i] = type;
    tileColors[i] = color;
    areaTiles[i] = area;
  };
  const place = (type: string, col: number, row: number, uid: string) => {
    furniture.push({ uid, type, col, row });
  };
  const tint = (color: Color | null, hue: number, sat = 35, bright?: number): Color | null =>
    color ? { ...color, h: hue, s: Math.max(color.s, sat), ...(bright !== undefined ? { b: bright } : {}) } : null;

  // ── Project rooms ──
  rooms.forEach((room, index) => {
    const isLeft = index % ROOMS_PER_ROW === 0;
    const offsetCol = isLeft ? 0 : rightColStart;
    const offsetRow = projectRow0 + Math.floor(index / ROOMS_PER_ROW) * BLOCK_ROWS;

    for (let r = 0; r < BLOCK_ROWS; r++) {
      for (let c = 0; c < BLOCK_COLS; c++) {
        const srcRow = BLOCK_ROW_START + r;
        if (srcRow >= t.rows || c >= t.cols) continue;
        const src = srcRow * t.cols + c;
        const tile = t.tiles[src];
        const color = t.tileColors?.[src] ?? null;
        const tinted = tile === LOUNGE_FLOOR ? tint(color, room.hue) : color;
        set(offsetCol + c, offsetRow + r, tile, tinted, tile !== WALL && tile !== VOID ? room.label : null);
      }
    }

    // Door into the corridor: the lounge's right wall (left column) or the
    // work room's left wall (right column).
    const doorCol = isLeft ? BLOCK_COLS - 1 : 0;
    const doorFloorSrc = (BLOCK_ROW_START + 3) * t.cols + (isLeft ? BLOCK_COLS - 2 : 1);
    for (const r of isLeft ? LEFT_BLOCK_DOOR_ROWS : RIGHT_BLOCK_DOOR_ROWS) {
      const doorTile = t.tiles[doorFloorSrc];
      const doorColor = t.tileColors?.[doorFloorSrc] ?? null;
      set(offsetCol + doorCol, offsetRow + r, doorTile, doorTile === LOUNGE_FLOOR ? tint(doorColor, room.hue) : doorColor, room.label);
    }

    for (const item of t.furniture) {
      if (item.col >= BLOCK_COLS) continue;
      if (item.row < BLOCK_ROW_START || item.row >= BLOCK_ROW_START + BLOCK_ROWS) continue;
      furniture.push({
        ...item,
        uid: `${item.uid}-room${index}`,
        col: item.col + offsetCol,
        row: item.row - BLOCK_ROW_START + offsetRow,
      });
    }
  });

  // ── Corridor between the two columns, from the entrance to the bottom ──
  const corridorColor = woodColor ? { ...woodColor, s: 20, b: -55 } : null;
  for (let c = BLOCK_COLS; c < rightColStart; c++) {
    set(c, 1, WALL, wallColor, null);
    for (let r = 2; r < rows - 1; r++) set(c, r, WOOD_FLOOR, corridorColor, null);
  }

  // ── Shared rooms ──
  /** A full-width room with walls and a 2-tile door into the corridor. */
  const buildRoom = (offsetCol: number, offsetRow: number, floor: number, color: Color | null, label: string) => {
    const isLeft = offsetCol === 0;
    const doorCol = isLeft ? BLOCK_COLS - 1 : 0;
    for (let c = 0; c < BLOCK_COLS; c++) set(offsetCol + c, offsetRow + 1, WALL, wallColor, null);
    for (let r = 2; r < BLOCK_ROWS - 1; r++) {
      set(offsetCol, offsetRow + r, WALL, wallColor, null);
      set(offsetCol + BLOCK_COLS - 1, offsetRow + r, WALL, wallColor, null);
      for (let c = 1; c < BLOCK_COLS - 1; c++) set(offsetCol + c, offsetRow + r, floor, color, label);
    }
    for (const r of SHARED_DOOR_ROWS) set(offsetCol + doorCol, offsetRow + r, floor, color, label);
  };
  const L = 0; // left column offset
  const Rt = rightColStart; // right column offset

  // Reception (top left): desk, waiting chairs, phone booths along the back wall.
  {
    const R = 0;
    buildRoom(L, R, WOOD_FLOOR, woodColor, RECEPTION_LABEL);
    place('DESK_FRONT', L + 6, R + 4, 'rcp-desk');
    place('PC_FRONT_OFF', L + 7, R + 4, 'rcp-pc');
    place('PLANT', L + 1, R + 1, 'rcp-plant');
    place('LARGE_PLANT', L + 16, R + 9, 'rcp-large-plant');
    place('CLOCK', L + 4, R, 'rcp-clock');
    place('LARGE_PAINTING', L + 6, R, 'rcp-painting');
    for (let i = 0; i < 6; i++) place('WAITING_CHAIR', L + 3 + i, R + 8, `rcp-chair-${i}`);
    for (let i = 0; i < 4; i++) place('PHONE_BOOTH', L + 11 + i * 2, R + 1, `rcp-booth-${i}`);
  }
  // Game room (top right): ping pong, foosball, bean bags.
  {
    const R = 0;
    buildRoom(Rt, R, LOUNGE_FLOOR, tint(loungeColor, 28, 45), GAME_LABEL);
    place('PINGPONG_TABLE', Rt + 4, R + 4, 'game-pingpong');
    place('FOOSBALL', Rt + 12, R + 4, 'game-foosball-1');
    place('FOOSBALL', Rt + 12, R + 8, 'game-foosball-2');
    for (let i = 0; i < 3; i++) place('BEAN_BAG', Rt + 3 + i * 2, R + 9, `game-beanbag-${i}`);
    place('PLANT_2', Rt + 17, R + 1, 'game-plant');
    place('SMALL_PAINTING', Rt + 9, R, 'game-painting');
  }

  // Kitchen (left) and napping room (right).
  {
    const R = kitchenRow;
    buildRoom(L, R, TILED_FLOOR, tiledColor, KITCHEN_LABEL);
    buildRoom(Rt, R, LOUNGE_FLOOR, tint(loungeColor, 232, 45, -45), NAP_LABEL);
    place('COFFEE_MACHINE', L + 3, R + 1, 'kitchen-coffee-1');
    place('COFFEE_MACHINE', L + 5, R + 1, 'kitchen-coffee-2');
    place('COFFEE_MACHINE', L + 7, R + 1, 'kitchen-coffee-3');
    place('CLOCK', L + 10, R, 'kitchen-clock');
    place('LARGE_PAINTING', L + 13, R, 'kitchen-painting');
    place('PLANT', L + 1, R + 1, 'kitchen-plant-1');
    place('PLANT_2', L + 17, R + 1, 'kitchen-plant-2');
    place('SMALL_TABLE_FRONT', L + 5, R + 6, 'kitchen-table-1');
    place('SMALL_TABLE_FRONT', L + 11, R + 6, 'kitchen-table-2');
    place('COFFEE', L + 5, R + 6, 'kitchen-mug-1');
    place('COFFEE', L + 12, R + 7, 'kitchen-mug-2');
    place('LARGE_PLANT', L + 16, R + 8, 'kitchen-large-plant');
    place('BIN', L + 1, R + 10, 'kitchen-bin');
    for (let i = 0; i < 8; i++) {
      place('BED', Rt + 2 + i * 2, R + 3, `nap-bed-a${i}`);
      place('BED', Rt + 2 + i * 2, R + 7, `nap-bed-b${i}`);
    }
    place('CLOCK', Rt + 9, R, 'nap-clock');
    place('HANGING_PLANT', Rt + 2, R, 'nap-hanging-plant');
    place('SMALL_PAINTING_2', Rt + 15, R, 'nap-painting');
    place('PLANT', Rt + 18, R + 10, 'nap-plant');
  }

  // Showers & WC (left) and gym (right).
  {
    const R = bathRow;
    buildRoom(L, R, TILED_FLOOR, tiledColor ? { ...tiledColor, h: 195, s: 25 } : null, BATH_LABEL);
    buildRoom(Rt, R, WOOD_FLOOR, woodColor ? { ...woodColor, s: 8, b: -70 } : null, GYM_LABEL);
    for (let i = 0; i < 3; i++) place('TOILET', L + 2 + i * 3, R + 2, `bath-toilet-${i}`);
    for (let i = 0; i < 3; i++) place('SHOWER', L + 12 + i * 2, R + 1, `bath-shower-${i}`);
    place('PLANT', L + 1, R + 9, 'bath-plant');
    place('BIN', L + 9, R + 10, 'bath-bin');
    for (let i = 0; i < 3; i++) place('TREADMILL', Rt + 2 + i * 2, R + 3, `gym-treadmill-${i}`);
    place('WEIGHT_RACK', Rt + 11, R + 2, 'gym-weights-1');
    place('WEIGHT_RACK', Rt + 14, R + 2, 'gym-weights-2');
    for (let i = 0; i < 3; i++) place('YOGA_MAT', Rt + 10 + i * 2, R + 7, `gym-mat-${i}`);
    place('CLOCK', Rt + 8, R, 'gym-clock');
    place('PLANT_2', Rt + 17, R + 9, 'gym-plant');
  }

  return {
    version: 1,
    cols,
    rows,
    layoutRevision: GENERATED_LAYOUT_REVISION,
    tiles,
    tileColors,
    furniture,
    areas: [
      ...rooms.map((r) => ({ label: r.label, color: r.color })),
      { label: RECEPTION_LABEL, color: '#3fa7a0' },
      { label: GAME_LABEL, color: '#e5893a' },
      { label: KITCHEN_LABEL, color: '#c08552' },
      { label: NAP_LABEL, color: '#5b6ee1' },
      { label: BATH_LABEL, color: '#4aa3d8' },
      { label: GYM_LABEL, color: '#d14f6a' },
    ],
    areaTiles,
  };
}
