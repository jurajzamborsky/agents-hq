/**
 * Agents HQ 3D: builds the static voxel office (floor, walls, furniture)
 * from the same OfficeLayout the 2D engine uses. One world unit = one tile;
 * tile (col,row) spans x∈[col,col+1], z∈[row,row+1], y is up.
 *
 * Furniture is hand-modelled from boxes per type (Allston-style voxels). Any
 * type without a model gets a neutral block so a new asset never breaks the
 * scene.
 */

import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';

import { getCatalogEntry } from '../office/layout/furnitureCatalog.js';
import type { OfficeLayout } from '../office/types.js';

const WALL = 0;
const VOID = 255;
export const WALL_HEIGHT = 1.35;
const DESK_HEIGHT = 0.72;

/** 'voxel' = hard Allston-style blocks; 'soft' = rounded pastel low-poly (POV). */
export type SceneStyle = 'voxel' | 'soft';

// ── Shared geometry/material caches ──
const voxelBox = new THREE.BoxGeometry(1, 1, 1);
const softBox = new RoundedBoxGeometry(1, 1, 1, 2, 0.12);
let style: SceneStyle = 'voxel';
let unitBox: THREE.BufferGeometry = voxelBox;
const materials = new Map<string, THREE.MeshLambertMaterial>();

/** Soft style: wash every color toward a warm white for the pastel look. */
export function pastel(color: string, amount = 0.38): string {
  const c = new THREE.Color(color).lerp(new THREE.Color('#fff6e8'), amount);
  return `#${c.getHexString()}`;
}

function mat(color: string): THREE.MeshLambertMaterial {
  const final = style === 'soft' ? pastel(color) : color;
  let m = materials.get(final);
  if (!m) {
    m = new THREE.MeshLambertMaterial({ color: final });
    materials.set(final, m);
  }
  return m;
}

/** A box given by its min corner and size, in tile units, inside `parent`. */
function box(
  parent: THREE.Object3D,
  x: number,
  y: number,
  z: number,
  w: number,
  h: number,
  d: number,
  color: string,
): THREE.Mesh {
  const mesh = new THREE.Mesh(unitBox, mat(color));
  mesh.scale.set(w, h, d);
  mesh.position.set(x + w / 2, y + h / 2, z + d / 2);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}

// ── Palette (Allston-ish: warm wood, saturated accents) ──
const C = {
  wood: '#9a6a43',
  woodDark: '#6e4a2f',
  woodLight: '#c49a6c',
  wall: '#3d4258',
  wallTop: '#565c78',
  sofa: '#b8324f',
  sofaDark: '#8a2239',
  cushion: '#5c8a5a',
  screen: '#1d2a44',
  screenGlow: '#4f8fd8',
  plastic: '#d9d9de',
  metal: '#8c9099',
  dark: '#2b2c31',
  leaf: '#4f9a4a',
  leafLight: '#73c262',
  pot: '#b5643c',
  white: '#f1efe9',
  blanket: '#4a68b8',
  blanketLight: '#6f8ad6',
  coffee: '#3b2418',
  red: '#d84141',
  frame: '#5b3a24',
  paint: ['#e3a94b', '#4b8bc9', '#c95b4b', '#6dbb8a'],
  books: ['#c94f4f', '#4f79c9', '#e0b84a', '#5aa36a', '#8a5ac9'],
};

function hexFromHsl(h: number, s: number, l: number): string {
  return `#${new THREE.Color().setHSL(h, s, l).getHexString()}`;
}

// ── Floors ──
function floorColor(layout: OfficeLayout, col: number, row: number, tile: number): string {
  const area = layout.areaTiles?.[row * layout.cols + col] ?? null;
  const areaColor = area ? layout.areas?.find((a) => a.label === area)?.color : undefined;
  switch (tile) {
    case 9: // tiled kitchen / kitchenette: checkerboard
      return (col + row) % 2 === 0 ? '#e9e6df' : '#3b3d46';
    case 1: {
      // lounge carpet, tinted with the room color
      if (areaColor) {
        const c = new THREE.Color(areaColor);
        const hsl = { h: 0, s: 0, l: 0 };
        c.getHSL(hsl);
        return hexFromHsl(hsl.h, Math.min(hsl.s, 0.55), 0.42);
      }
      return '#5b6c8f';
    }
    case 7:
      return area ? ((col + row) % 2 === 0 ? '#a7744b' : '#9d6c45') : '#6b5948'; // wood / corridor
    default:
      return (col + row) % 2 === 0 ? '#9c8f80' : '#958879';
  }
}

// ── Furniture models ──
type Model = (g: THREE.Group, w: number, d: number, variant: string, onSurface: number) => void;

const chair: Model = (g, _w, _d, variant) => {
  const cushion = variant.includes('CUSHIONED') ? C.cushion : C.wood;
  box(g, 0.2, 0.36, 0.2, 0.6, 0.1, 0.6, cushion);
  for (const [lx, lz] of [
    [0.22, 0.22],
    [0.7, 0.22],
    [0.22, 0.7],
    [0.7, 0.7],
  ]) {
    box(g, lx, 0, lz, 0.08, 0.36, 0.08, C.woodDark);
  }
  if (variant.includes('BENCH')) return;
  // Backrest on the side away from the desk the chair faces.
  if (variant.includes('FRONT')) box(g, 0.2, 0.46, 0.2, 0.6, 0.45, 0.08, C.woodDark);
  else if (variant.includes('BACK')) box(g, 0.2, 0.46, 0.72, 0.6, 0.45, 0.08, C.woodDark);
  else if (variant.endsWith(':left')) box(g, 0.72, 0.46, 0.2, 0.08, 0.45, 0.6, C.woodDark);
  else box(g, 0.2, 0.46, 0.2, 0.08, 0.45, 0.6, C.woodDark);
};

const table =
  (height: number, top: string): Model =>
  (g, w, d) => {
    box(g, 0.05, height - 0.08, 0.05, w - 0.1, 0.08, d - 0.1, top);
    for (const [lx, lz] of [
      [0.1, 0.1],
      [w - 0.2, 0.1],
      [0.1, d - 0.2],
      [w - 0.2, d - 0.2],
    ]) {
      box(g, lx, 0, lz, 0.1, height - 0.08, 0.1, C.woodDark);
    }
  };

const MODELS: Record<string, Model> = {
  DESK: table(DESK_HEIGHT, C.wood),
  TABLE_FRONT: table(DESK_HEIGHT, C.woodLight),
  SMALL_TABLE: table(0.7, C.woodLight),
  COFFEE_TABLE: table(0.32, C.woodLight),
  CHAIR: chair,
  BENCH: chair,
  SOFA: (g, w, d, variant) => {
    box(g, 0.05, 0, 0.05, w - 0.1, 0.3, d - 0.1, C.sofaDark);
    box(g, 0.08, 0.3, 0.08, w - 0.16, 0.12, d - 0.16, C.sofa);
    // Backrest away from the direction the sofa faces.
    if (variant.includes('FRONT')) box(g, 0.05, 0.3, 0.05, w - 0.1, 0.5, 0.22, C.sofaDark);
    else if (variant.includes('BACK')) box(g, 0.05, 0.3, d - 0.27, w - 0.1, 0.5, 0.22, C.sofaDark);
    else if (variant.endsWith(':left')) box(g, w - 0.27, 0.3, 0.05, 0.22, 0.5, d - 0.1, C.sofaDark);
    else box(g, 0.05, 0.3, 0.05, 0.22, 0.5, d - 0.1, C.sofaDark);
  },
  PC: (g, _w, _d, variant, onSurface) => {
    const y = onSurface;
    const side = variant.includes('SIDE');
    box(g, 0.4, y, 0.4, 0.2, 0.05, 0.2, C.dark);
    box(g, 0.47, y + 0.05, 0.47, 0.06, 0.12, 0.06, C.dark);
    const on = variant.includes('_ON');
    const screen = on ? C.screenGlow : C.screen;
    if (side) {
      box(g, 0.44, y + 0.15, 0.15, 0.12, 0.38, 0.7, C.dark);
      box(g, variant.endsWith(':left') ? 0.42 : 0.56, y + 0.19, 0.2, 0.02, 0.3, 0.6, screen);
    } else {
      box(g, 0.15, y + 0.15, 0.44, 0.7, 0.38, 0.12, C.dark);
      box(g, 0.2, y + 0.19, variant.includes('BACK') ? 0.42 : 0.56, 0.6, 0.3, 0.02, screen);
    }
  },
  BOOKSHELF: (g, w) => {
    box(g, 0.02, 0.15, 0, w - 0.04, 1.1, 0.3, C.woodDark);
    for (let shelf = 0; shelf < 3; shelf++) {
      let x = 0.08;
      let i = shelf;
      while (x < w - 0.15) {
        const bw = 0.08 + ((i * 37) % 5) * 0.015;
        box(g, x, 0.22 + shelf * 0.34, 0.2, bw, 0.26, 0.12, C.books[i % C.books.length]);
        x += bw + 0.02;
        i++;
      }
    }
  },
  PAINTING: (g, w, _d, variant) => {
    const color = C.paint[variant.length % C.paint.length];
    box(g, 0.1, 0.5, 0.25, w - 0.2, w > 1 ? 0.6 : 0.45, 0.06, C.frame);
    box(g, 0.16, 0.56, 0.3, w - 0.32, w > 1 ? 0.48 : 0.33, 0.03, color);
  },
  CLOCK: (g) => {
    box(g, 0.28, 0.75, 0.25, 0.44, 0.44, 0.06, C.white);
    box(g, 0.48, 0.92, 0.31, 0.04, 0.18, 0.02, C.dark);
    box(g, 0.48, 0.95, 0.31, 0.15, 0.04, 0.02, C.dark);
  },
  WHITEBOARD: (g, w) => {
    box(g, 0.1, 0.45, 0.25, w - 0.2, 0.7, 0.05, C.white);
  },
  HANGING_PLANT: (g) => {
    box(g, 0.3, 0.9, 0.15, 0.4, 0.25, 0.3, C.pot);
    box(g, 0.2, 0.55, 0.12, 0.6, 0.4, 0.4, C.leaf);
  },
  PLANT: (g, w, d) => {
    const s = Math.min(w, d);
    box(g, 0.3 * s, 0, 0.3 * s, 0.4 * s, 0.3, 0.4 * s, C.pot);
    box(g, 0.2 * s, 0.3, 0.2 * s, 0.6 * s, 0.45 * (w > 1 ? 2 : 1), 0.6 * s, C.leaf);
    box(g, 0.3 * s, 0.65 * (w > 1 ? 1.6 : 1), 0.3 * s, 0.4 * s, 0.3, 0.4 * s, C.leafLight);
  },
  CACTUS: (g) => {
    box(g, 0.3, 0, 0.3, 0.4, 0.25, 0.4, C.pot);
    box(g, 0.4, 0.25, 0.4, 0.2, 0.6, 0.2, C.leaf);
  },
  POT: (g) => {
    box(g, 0.3, 0, 0.3, 0.4, 0.3, 0.4, C.pot);
  },
  BIN: (g) => {
    box(g, 0.3, 0, 0.3, 0.4, 0.4, 0.4, C.metal);
    box(g, 0.33, 0.38, 0.33, 0.34, 0.03, 0.34, C.dark);
  },
  COFFEE: (g, _w, _d, _v, onSurface) => {
    box(g, 0.42, onSurface, 0.42, 0.16, 0.16, 0.16, C.white);
    box(g, 0.45, onSurface + 0.14, 0.45, 0.1, 0.02, 0.1, C.coffee);
  },
  COFFEE_MACHINE: (g) => {
    box(g, 0.15, 0, 0.1, 0.7, 1.05, 0.6, C.dark);
    box(g, 0.2, 0.62, 0.68, 0.6, 0.25, 0.04, '#45474f');
    box(g, 0.28, 0.7, 0.71, 0.3, 0.1, 0.02, C.screenGlow);
    box(g, 0.66, 0.73, 0.71, 0.06, 0.06, 0.02, C.red);
    box(g, 0.3, 0.12, 0.52, 0.4, 0.32, 0.25, '#9fb4c0');
    box(g, 0.32, 0.14, 0.54, 0.36, 0.18, 0.21, C.coffee);
  },
  WAITING_CHAIR: (g) => {
    box(g, 0.15, 0.3, 0.15, 0.7, 0.14, 0.62, '#2f9aa3');
    box(g, 0.15, 0.44, 0.12, 0.7, 0.5, 0.12, '#257f87');
    box(g, 0.1, 0.3, 0.15, 0.08, 0.3, 0.62, C.metal);
    box(g, 0.82, 0.3, 0.15, 0.08, 0.3, 0.62, C.metal);
    for (const x of [0.18, 0.74]) box(g, x, 0, 0.45, 0.08, 0.3, 0.08, C.dark);
  },
  PHONE_BOOTH: (g) => {
    // Open-front booth: back + side panels, roof, phone on the back wall.
    box(g, 0.05, 0, 0.0, 0.9, 2.1, 0.08, '#3a4256');
    box(g, 0.05, 0, 0.0, 0.08, 2.1, 0.95, '#e8963c');
    box(g, 0.87, 0, 0.0, 0.08, 2.1, 0.95, '#e8963c');
    box(g, 0.05, 2.1, 0.0, 0.9, 0.12, 0.95, '#e8963c');
    box(g, 0.38, 1.05, 0.08, 0.24, 0.3, 0.08, C.dark);
    box(g, 0.43, 1.12, 0.16, 0.06, 0.16, 0.04, '#5bd16b');
  },
  TOILET: (g) => {
    box(g, 0.28, 0, 0.05, 0.44, 0.75, 0.2, C.white); // tank
    box(g, 0.25, 0, 0.25, 0.5, 0.36, 0.55, C.white); // bowl
    box(g, 0.27, 0.36, 0.27, 0.46, 0.04, 0.5, '#d8dde2'); // seat
    // Stall panels
    box(g, 0, 0, 0, 0.05, 1.6, 1, '#7fb2d6');
    box(g, 0.95, 0, 0, 0.05, 1.6, 1, '#7fb2d6');
  },
  SHOWER: (g) => {
    box(g, 0.05, 0, 0.0, 0.9, 0.06, 0.95, '#cfe3ee'); // tray
    box(g, 0.05, 0, 0.0, 0.9, 2.1, 0.06, '#bcd8e6'); // tiled back
    box(g, 0.05, 0, 0.0, 0.06, 2.1, 0.95, '#bcd8e6');
    box(g, 0.89, 0, 0.0, 0.06, 2.1, 0.95, '#a9cde0');
    box(g, 0.44, 1.75, 0.06, 0.12, 0.06, 0.35, C.metal); // arm
    box(g, 0.38, 1.68, 0.35, 0.24, 0.07, 0.24, C.metal); // head
    for (const [x, z] of [[0.42, 0.42], [0.55, 0.5], [0.47, 0.58]]) box(g, x, 0.4, z, 0.03, 1.2, 0.03, '#7fc4f2');
  },
  TREADMILL: (g, _w, d) => {
    box(g, 0.12, 0, 0.1, 0.76, 0.16, d - 0.15, C.dark);
    box(g, 0.18, 0.16, 0.15, 0.64, 0.03, d - 0.25, '#3a3b40');
    box(g, 0.12, 0, 0.1, 0.06, 1.1, 0.06, C.metal);
    box(g, 0.82, 0, 0.1, 0.06, 1.1, 0.06, C.metal);
    box(g, 0.12, 1.05, 0.05, 0.76, 0.2, 0.18, C.dark); // console
    box(g, 0.3, 1.12, 0.22, 0.4, 0.1, 0.02, C.screenGlow);
  },
  WEIGHT_RACK: (g, w) => {
    box(g, 0.05, 0, 0.3, w - 0.1, 0.06, 0.4, C.dark);
    box(g, 0.05, 0.45, 0.3, w - 0.1, 0.06, 0.4, C.dark);
    box(g, 0.05, 0, 0.3, 0.06, 0.5, 0.4, C.metal);
    box(g, w - 0.11, 0, 0.3, 0.06, 0.5, 0.4, C.metal);
    const colors = [C.red, '#3f6fd6', C.dark, '#e0b84a', '#4caf6a'];
    let x = 0.15;
    for (let i = 0; x < w - 0.3; i++) {
      for (const y of [0.06, 0.51]) {
        box(g, x, y, 0.38, 0.06, 0.16, 0.24, colors[i % colors.length]);
        box(g, x + 0.18, y, 0.38, 0.06, 0.16, 0.24, colors[i % colors.length]);
        box(g, x + 0.06, y + 0.06, 0.48, 0.12, 0.04, 0.04, C.metal);
      }
      x += 0.36;
    }
  },
  YOGA_MAT: (g, _w, d) => {
    box(g, 0.15, 0, 0.1, 0.7, 0.03, d - 0.2, '#8a5ac9');
    box(g, 0.15, 0.03, 0.1, 0.7, 0.05, 0.2, '#6c45a3');
  },
  PINGPONG_TABLE: (g, w, d) => {
    box(g, 0.1, 0.68, 0.1, w - 0.2, 0.06, d - 0.2, '#2f7d5c');
    box(g, 0.1, 0.74, d / 2 - 0.02, w - 0.2, 0.005, 0.04, C.white);
    box(g, w / 2 - 0.02, 0.74, 0.1, 0.04, 0.005, d - 0.2, C.white);
    box(g, w / 2 - 0.03, 0.74, 0.05, 0.06, 0.16, d - 0.1, '#e6e6e6'); // net
    for (const [x, z] of [[0.3, 0.3], [w - 0.4, 0.3], [0.3, d - 0.4], [w - 0.4, d - 0.4]]) box(g, x, 0, z, 0.1, 0.68, 0.1, C.dark);
  },
  FOOSBALL: (g, w, d) => {
    box(g, 0.05, 0.45, 0.1, w - 0.1, 0.35, d - 0.2, C.wood);
    box(g, 0.15, 0.78, 0.18, w - 0.3, 0.03, d - 0.36, '#3f9a56');
    for (let i = 0; i < 4; i++) {
      const x = 0.3 + i * ((w - 0.6) / 3);
      box(g, x, 0.85, -0.05, 0.03, 0.03, d + 0.1, C.metal);
      box(g, x - 0.04, 0.78, d / 2 - 0.05, 0.11, 0.12, 0.1, i % 2 ? '#3f6fd6' : C.red);
    }
    for (const x of [0.1, w - 0.2]) box(g, x, 0, d / 2 - 0.05, 0.1, 0.45, 0.1, C.woodDark);
  },
  BEAN_BAG: (g) => {
    box(g, 0.12, 0, 0.12, 0.76, 0.32, 0.76, '#e8963c');
    box(g, 0.2, 0.32, 0.12, 0.6, 0.25, 0.3, '#f0a95a');
  },
  BED: (g, w, d) => {
    box(g, 0.05, 0, 0.02, w - 0.1, 0.75, 0.12, C.frame); // headboard (north)
    box(g, 0.05, 0, 0.12, w - 0.1, 0.3, d - 0.18, C.woodDark);
    box(g, 0.08, 0.3, 0.14, w - 0.16, 0.14, d - 0.22, C.white);
    box(g, 0.15, 0.44, 0.2, w - 0.3, 0.1, 0.35, C.white);
    box(g, 0.07, 0.44, 0.65, w - 0.14, 0.08, d - 0.75, C.blanket);
    box(g, 0.07, 0.5, 0.65, w - 0.14, 0.03, 0.15, C.blanketLight);
    box(g, 0.05, 0, d - 0.1, w - 0.1, 0.45, 0.08, C.frame); // footboard
  },
};

function modelFor(type: string): Model | null {
  const base = type.replace(/:left$/, '');
  const keys = Object.keys(MODELS).sort((a, b) => b.length - a.length);
  for (const k of keys) if (base.startsWith(k) || base.includes(`_${k}`) || base === k) return MODELS[k];
  if (base.includes('CHAIR')) return MODELS.CHAIR;
  if (base.includes('BENCH')) return MODELS.BENCH;
  if (base.includes('PAINTING')) return MODELS.PAINTING;
  if (base.includes('BOOKSHELF')) return MODELS.BOOKSHELF;
  if (base.includes('PLANT')) return MODELS.PLANT;
  return null;
}

export interface StaticScene {
  group: THREE.Group;
  /** Tiles covered by desks/tables, used to lift surface items. */
  center: THREE.Vector3;
  size: { cols: number; rows: number };
}

export interface SceneOptions {
  style: SceneStyle;
  /** Wall height in tiles: low for the top-down view, full height for POV. */
  wallHeight: number;
  /** POV: add a ceiling with pendant lamps over every room. */
  ceiling: boolean;
  /** Lobby sign at the top of the corridor, e.g. "Acme Agents HQ". */
  signTitle?: string;
  signSubtitle?: string;
  /** Display name for a room label (translation). */
  roomName?: (label: string) => string;
}

export function buildStaticScene(
  layout: OfficeLayout,
  options: SceneOptions = { style: 'voxel', wallHeight: WALL_HEIGHT, ceiling: false },
): StaticScene {
  style = options.style;
  unitBox = style === 'soft' ? softBox : voxelBox;
  const wallH = options.wallHeight;
  const group = new THREE.Group();
  const { cols, rows, tiles } = layout;

  // Floor + walls as instanced boxes (thousands of tiles, two draw calls).
  let floorCount = 0;
  let wallCount = 0;
  for (const t of tiles) {
    if (t === WALL) wallCount++;
    else if (t !== VOID) floorCount++;
  }
  // Floors and walls stay square in both styles (rounded tiles would show seams).
  const floor = new THREE.InstancedMesh(voxelBox, new THREE.MeshLambertMaterial(), floorCount);
  const walls = new THREE.InstancedMesh(voxelBox, new THREE.MeshLambertMaterial(), wallCount);
  floor.receiveShadow = true;
  // Full-height POV walls would throw the whole corridor into shadow.
  walls.castShadow = !options.ceiling;
  walls.receiveShadow = true;
  const m = new THREE.Matrix4();
  const color = new THREE.Color();
  let fi = 0;
  let wi = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const t = tiles[r * cols + c];
      if (t === VOID) continue;
      if (t === WALL) {
        m.makeScale(1, wallH, 1).setPosition(c + 0.5, wallH / 2, r + 0.5);
        walls.setMatrixAt(wi, m);
        walls.setColorAt(
          wi,
          color.set(style === 'soft' ? ((c + r) % 2 === 0 ? '#efe3cf' : '#ebdec8') : (c + r) % 2 === 0 ? C.wall : '#42475e'),
        );
        wi++;
      } else {
        m.makeScale(1, 0.1, 1).setPosition(c + 0.5, -0.05, r + 0.5);
        floor.setMatrixAt(fi, m);
        const fc = floorColor(layout, c, r, t);
        floor.setColorAt(fi, color.set(style === 'soft' ? pastel(fc, 0.3) : fc));
        fi++;
      }
    }
  }
  group.add(floor, walls);

  // Desk/table tiles: items marked canPlaceOnSurfaces sit on top of them.
  const surface = new Map<string, number>();
  for (const item of layout.furniture) {
    const entry = getCatalogEntry(item.type);
    if (!entry) continue;
    const base = item.type.replace(/:left$/, '');
    const h = base.startsWith('COFFEE_TABLE')
      ? 0.32
      : entry.isDesk || base.includes('TABLE') || base.startsWith('DESK')
        ? DESK_HEIGHT
        : 0;
    if (!h) continue;
    for (let dr = 0; dr < entry.footprintH; dr++) {
      for (let dc = 0; dc < entry.footprintW; dc++) surface.set(`${item.col + dc},${item.row + dr}`, h);
    }
  }

  for (const item of layout.furniture) {
    const entry = getCatalogEntry(item.type);
    if (!entry) continue;
    const model = modelFor(item.type);
    const isWallItem = entry.category === 'wall' || entry.canPlaceOnWalls;
    const g = new THREE.Group();
    if (isWallItem) {
      // Wall-mounted items sit in the row above the wall; hang them on the
      // wall's room-facing side, raised to eye height.
      const wallRow = item.row + entry.footprintH - 1;
      g.position.set(item.col, wallH > 2 ? 0.75 : 0.25, wallRow + 0.75);
      (model ?? MODELS.PAINTING)(g, entry.footprintW, 1, item.type, 0);
    } else {
      // Background rows are the part drawn "behind" in 2D; the 3D base is the rest.
      const bg = entry.backgroundTiles ?? 0;
      const depth = Math.max(1, entry.footprintH - bg);
      const onSurface = entry.canPlaceOnSurfaces ? (surface.get(`${item.col},${item.row + bg}`) ?? 0) : 0;
      g.position.set(item.col, 0, item.row + bg);
      if (model) model(g, entry.footprintW, depth, item.type, onSurface);
      else box(g, 0.15, 0, 0.15, entry.footprintW - 0.3, 0.5, depth - 0.3, C.plastic);
    }
    group.add(g);
  }

  if (options.ceiling) (style === 'voxel' ? addVoxelCeiling : addCeiling)(group, layout, wallH);
  addDoorSigns(group, layout, wallH, options);

  return {
    group,
    center: new THREE.Vector3(cols / 2, 0, rows / 2),
    size: { cols, rows },
  };
}

/** POV: a ceiling over the whole floor plan and a pendant lamp every few tiles
 *  inside each room. Lamps are emissive meshes, not real lights, so they cost
 *  nothing at runtime. */
function addCeiling(group: THREE.Group, layout: OfficeLayout, wallH: number): void {
  const { cols, rows, tiles } = layout;
  const ceiling = new THREE.Mesh(
    new THREE.PlaneGeometry(cols, rows),
    new THREE.MeshLambertMaterial({ color: '#f4efe6', side: THREE.DoubleSide }),
  );
  ceiling.rotation.x = Math.PI / 2;
  ceiling.position.set(cols / 2, wallH, rows / 2);
  group.add(ceiling);

  // Ceiling panel grid lines.
  const lineMat = new THREE.LineBasicMaterial({ color: '#d9d1c3' });
  const pts: THREE.Vector3[] = [];
  for (let c = 0; c <= cols; c += 2) pts.push(new THREE.Vector3(c, wallH - 0.01, 0), new THREE.Vector3(c, wallH - 0.01, rows));
  for (let r = 0; r <= rows; r += 2) pts.push(new THREE.Vector3(0, wallH - 0.01, r), new THREE.Vector3(cols, wallH - 0.01, r));
  group.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), lineMat));

  const shade = new THREE.MeshLambertMaterial({ color: '#e8b04a' });
  const bulb = new THREE.MeshBasicMaterial({ color: '#fff3c4' });
  const cord = new THREE.LineBasicMaterial({ color: '#7a7066' });
  const shadeGeo = new THREE.ConeGeometry(0.28, 0.22, 16, 1, true);
  const bulbGeo = new THREE.SphereGeometry(0.1, 12, 8);
  for (let r = 3; r < rows; r += 5) {
    for (let c = 3; c < cols; c += 5) {
      const t = tiles[r * cols + c];
      if (t === WALL || t === VOID) continue;
      const lampY = wallH - 0.7;
      const s = new THREE.Mesh(shadeGeo, shade);
      s.position.set(c + 0.5, lampY, r + 0.5);
      const b = new THREE.Mesh(bulbGeo, bulb);
      b.position.set(c + 0.5, lampY - 0.08, r + 0.5);
      const line = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([
          new THREE.Vector3(c + 0.5, wallH, r + 0.5),
          new THREE.Vector3(c + 0.5, lampY + 0.11, r + 0.5),
        ]),
        cord,
      );
      group.add(s, b, line);
    }
  }
}

/** POV in the voxel style: a ceiling of block tiles over every floor tile and
 *  blocky pendant lamps — same look as the rest of the voxel office. */
function addVoxelCeiling(group: THREE.Group, layout: OfficeLayout, wallH: number): void {
  const { cols, rows, tiles } = layout;
  let count = 0;
  for (const t of tiles) if (t !== VOID) count++;
  const ceiling = new THREE.InstancedMesh(voxelBox, new THREE.MeshLambertMaterial(), count);
  const m = new THREE.Matrix4();
  const color = new THREE.Color();
  let i = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (tiles[r * cols + c] === VOID) continue;
      m.makeScale(1, 0.2, 1).setPosition(c + 0.5, wallH + 0.1, r + 0.5);
      ceiling.setMatrixAt(i, m);
      ceiling.setColorAt(i, color.set((c + r) % 2 === 0 ? '#d9d2c3' : '#cfc7b6'));
      i++;
    }
  }
  group.add(ceiling);

  for (let r = 3; r < rows; r += 5) {
    for (let c = 3; c < cols; c += 5) {
      const t = tiles[r * cols + c];
      if (t === WALL || t === VOID) continue;
      const lamp = new THREE.Group();
      lamp.position.set(c, 0, r);
      box(lamp, 0.47, wallH - 0.62, 0.47, 0.06, 0.62, 0.06, C.dark); // cord
      box(lamp, 0.25, wallH - 0.85, 0.25, 0.5, 0.24, 0.5, '#e8a33c'); // shade
      const bulb = new THREE.Mesh(voxelBox, new THREE.MeshBasicMaterial({ color: '#fff3c4' }));
      bulb.scale.set(0.24, 0.12, 0.24);
      bulb.position.set(0.5, wallH - 0.9, 0.5);
      lamp.add(bulb);
      group.add(lamp);
    }
  }
}

/**
 * Coworking-style blade signs: at every door from a room into the corridor, a
 * double-sided board sticks out of the wall with the room's emoji and name on
 * the room color. Perpendicular to the wall, so it reads from above (3D) and
 * when walking down the corridor (POV).
 */
function addDoorSigns(group: THREE.Group, layout: OfficeLayout, wallH: number, options: SceneOptions): void {
  const { cols, rows, tiles, areaTiles, areas } = layout;
  if (!areaTiles || !areas) return;
  const isFloor = (c: number, r: number) => {
    if (c < 0 || r < 0 || c >= cols || r >= rows) return false;
    const t = tiles[r * cols + c];
    return t !== WALL && t !== VOID;
  };
  const areaAt = (c: number, r: number) => areaTiles[r * cols + c] ?? null;

  // Top-most door tile per area: an area tile whose side neighbour is corridor
  // floor (walkable, no area).
  const doors = new Map<string, { col: number; row: number; dir: 1 | -1 }>();
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const label = areaAt(c, r);
      if (!label || doors.has(label) || !isFloor(c, r)) continue;
      for (const dir of [1, -1] as const) {
        if (isFloor(c + dir, r) && !areaAt(c + dir, r)) {
          doors.set(label, { col: c, row: r, dir });
          break;
        }
      }
    }
  }

  addHubSign(group, layout, wallH, isFloor, areaAt, options);

  const boardW = 1.35;
  const boardH = 0.5;
  const y = wallH > 2 ? 2.05 : 0.78;
  for (const [label, door] of doors) {
    const color = areas.find((a) => a.label === label)?.color ?? '#555a70';
    const texture = signTexture(options.roomName ? options.roomName(label) : label, color);
    const face = new THREE.MeshBasicMaterial({ map: texture });
    const edge = new THREE.MeshLambertMaterial({ color: '#2b2c31' });
    const board = new THREE.Mesh(new THREE.BoxGeometry(boardW, boardH, 0.07), [edge, edge, edge, edge, face, face]);
    // From the wall face out into the corridor, at the door's upper edge.
    const wallFaceX = door.dir > 0 ? door.col + 1 : door.col;
    const x = wallFaceX + door.dir * (boardW / 2 + 0.08);
    const z = door.row + 0.04;
    board.position.set(x, y + boardH / 2, z);
    board.castShadow = true;
    group.add(board);
    // Bracket from the wall.
    const bracket = new THREE.Mesh(voxelBox, edge);
    bracket.scale.set(boardW + 0.12, 0.05, 0.05);
    bracket.position.set(wallFaceX + door.dir * ((boardW + 0.12) / 2), y + boardH + 0.04, z);
    group.add(bracket);
  }
}

/** "Agents HQ" (or "<company> Agents HQ") on the wall at the top end of the corridor, like a lobby sign. */
function addHubSign(
  group: THREE.Group,
  layout: OfficeLayout,
  wallH: number,
  isFloor: (c: number, r: number) => boolean,
  areaAt: (c: number, r: number) => string | null,
  options: SceneOptions,
): void {
  // Corridor = floor without an Area; its top row sits right under a wall.
  for (let r = 0; r < layout.rows; r++) {
    const corridor: number[] = [];
    for (let c = 0; c < layout.cols; c++) if (isFloor(c, r) && !areaAt(c, r)) corridor.push(c);
    if (corridor.length === 0) continue;
    const minC = Math.min(...corridor);
    const width = Math.max(...corridor) - minC + 1;
    const texture = signTexture(options.signTitle ?? 'Agents HQ', '#1c1633', options.signSubtitle);
    const face = new THREE.MeshBasicMaterial({ map: texture });
    const edge = new THREE.MeshLambertMaterial({ color: '#2b2c31' });
    const h = Math.min(0.9, width * 0.37);
    const board = new THREE.Mesh(new THREE.BoxGeometry(width - 0.2, h, 0.08), [edge, edge, edge, edge, face, edge]);
    board.position.set(minC + width / 2, wallH > 2 ? wallH - h / 2 - 0.35 : wallH - h / 2 - 0.08, r + 0.05);
    group.add(board);
    return;
  }
}

const signCache = new Map<string, THREE.CanvasTexture>();
function signTexture(label: string, color: string, subtitle?: string): THREE.CanvasTexture {
  // Textures drawn before the brand fonts load are redrawn once they are ready.
  const key = `${label}|${color}|${subtitle ?? ''}|${document.fonts?.status ?? ''}`;
  const cached = signCache.get(key);
  if (cached) return cached;
  const canvas = document.createElement('canvas');
  canvas.width = 540;
  canvas.height = 200;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = 'rgba(0,0,0,0.22)';
  ctx.fillRect(0, canvas.height - 26, canvas.width, 26);
  ctx.strokeStyle = 'rgba(255,255,255,0.85)';
  ctx.lineWidth = 8;
  ctx.strokeRect(10, 10, canvas.width - 20, canvas.height - 20);
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  let size = 84;
  const font = (px: number) => `800 ${px}px "Bricolage Grotesque Variable", -apple-system, Arial, sans-serif`;
  ctx.font = font(size);
  while (ctx.measureText(label).width > canvas.width - 60 && size > 36) {
    size -= 4;
    ctx.font = font(size);
  }
  ctx.shadowColor = 'rgba(0,0,0,0.35)';
  ctx.shadowOffsetY = 4;
  if (subtitle) {
    ctx.fillText(label, canvas.width / 2, canvas.height / 2 - 22);
    ctx.shadowOffsetY = 2;
    ctx.font = `700 ${Math.round(size * 0.4)}px "Bricolage Grotesque Variable", -apple-system, Arial, sans-serif`;
    ctx.fillStyle = '#c6f05a';
    ctx.fillText(subtitle, canvas.width / 2, canvas.height / 2 + size * 0.45);
  } else {
    ctx.fillText(label, canvas.width / 2, canvas.height / 2 - 4);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  signCache.set(key, texture);
  return texture;
}
