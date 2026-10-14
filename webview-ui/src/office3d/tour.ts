/**
 * Agents HQ: guided camera tour (`?tour=1`), for the promo video and for
 * showing the office on a screen. First a flight over the office from above,
 * then (after ISO_DURATION) the app switches to POV and the camera walks the
 * corridor, peeks into the game room and ends in a project room with agents. Positions come from the
 * generated rooms layout (rooms.ts): 20-tile room blocks, a 3-tile corridor,
 * shared rooms at the top and bottom.
 */

import type * as THREE from 'three';

import type { OfficeLayout } from '../office/types.js';

export const ISO_DURATION = 11;
export const POV_DURATION = 18;

const CORRIDOR_X = 21.5;
const RIGHT_DOOR_ROW = 5.5;
const BLOCK_ROWS = 13;

/** With `tourWait=1` the tour starts on a `hq-start-tour` window event (used by the video recorder). */
export function tourWaits(): boolean {
  try {
    return new URLSearchParams(location.search).get('tourWait') === '1';
  } catch {
    return false;
  }
}

export function tourEnabled(): boolean {
  try {
    return new URLSearchParams(location.search).get('tour') === '1';
  } catch {
    return false;
  }
}

const smooth = (t: number) => t * t * (3 - 2 * t);

interface IsoKey {
  t: number;
  x: number;
  z: number;
  zoom: number;
  turn: number;
}

interface PovKey {
  t: number;
  x: number;
  z: number;
  yaw: number;
  pitch: number;
}

function lerpKeys<K extends { t: number }>(keys: K[], t: number): { a: K; b: K; k: number } {
  if (t <= keys[0].t) return { a: keys[0], b: keys[0], k: 0 };
  for (let i = 1; i < keys.length; i++) {
    if (t <= keys[i].t) {
      const a = keys[i - 1];
      const b = keys[i];
      return { a, b, k: smooth((t - a.t) / (b.t - a.t)) };
    }
  }
  const last = keys[keys.length - 1];
  return { a: last, b: last, k: 0 };
}

const mix = (a: number, b: number, k: number) => a + (b - a) * k;

/** Top-down flight: whole office, the lobby, then into the project rooms. */
export function isoTourFrame(
  t: number,
  layout: OfficeLayout,
  ortho: THREE.OrthographicCamera,
  target: THREE.Vector3,
): void {
  const cx = layout.cols / 2;
  const keys: IsoKey[] = [
    { t: 0, x: cx, z: layout.rows * 0.45, zoom: 0.3, turn: -0.25 },
    { t: 3.5, x: cx, z: 9, zoom: 0.62, turn: 0 },
    { t: 7, x: cx + 2, z: BLOCK_ROWS + 7, zoom: 1.05, turn: 0.18 },
    { t: ISO_DURATION, x: cx + 4, z: BLOCK_ROWS + 6, zoom: 1.6, turn: 0.32 },
  ];
  const { a, b, k } = lerpKeys(keys, t);
  target.set(mix(a.x, b.x, k), 0, mix(a.z, b.z, k));
  const turn = mix(a.turn, b.turn, k);
  // Same camera angle as the regular view (offset 30, 42, 34), turned around the vertical axis.
  const r = Math.hypot(30, 34);
  const base = Math.atan2(30, 34);
  ortho.position.set(target.x + Math.sin(base + turn) * r, 42, target.z + Math.cos(base + turn) * r);
  ortho.zoom = mix(a.zoom, b.zoom, k);
  ortho.lookAt(target);
  ortho.updateProjectionMatrix();
}

/** First-person walk: lobby sign, a peek into the game room, then into a project room full of agents. */
export function povTourFrame(t: number, _layout: OfficeLayout, camera: THREE.PerspectiveCamera): void {
  const doorZ = BLOCK_ROWS + RIGHT_DOOR_ROW + 0.5; // first right-hand project room
  const gameDoorZ = RIGHT_DOOR_ROW + 0.5;
  // Yaw: 0 faces the lobby sign (-z), -π/2 faces east (+x), -π faces down the corridor (+z).
  const keys: PovKey[] = [
    { t: 0, x: CORRIDOR_X, z: 8, yaw: 0, pitch: 0.2 },
    { t: 1.8, x: CORRIDOR_X, z: 7.6, yaw: 0, pitch: 0.14 },
    { t: 3.2, x: CORRIDOR_X + 0.4, z: gameDoorZ, yaw: -Math.PI / 2, pitch: -0.08 },
    { t: 5, x: 25.5, z: gameDoorZ, yaw: -Math.PI / 2, pitch: -0.12 },
    { t: 6.6, x: 26, z: gameDoorZ + 0.3, yaw: -1.15, pitch: -0.16 },
    { t: 8, x: 22.2, z: gameDoorZ + 0.6, yaw: -Math.PI, pitch: -0.05 },
    { t: 10.2, x: CORRIDOR_X, z: doorZ, yaw: -Math.PI, pitch: -0.05 },
    { t: 11.2, x: CORRIDOR_X + 0.6, z: doorZ, yaw: -Math.PI / 2, pitch: -0.12 },
    { t: 13.2, x: 25.2, z: doorZ, yaw: -2.0, pitch: -0.26 },
    { t: 15.6, x: 26, z: doorZ - 0.4, yaw: -1.05, pitch: -0.2 },
    { t: POV_DURATION, x: 25.6, z: doorZ + 0.2, yaw: -1.6, pitch: -0.18 },
  ];
  const { a, b, k } = lerpKeys(keys, t);
  camera.position.set(mix(a.x, b.x, k), 1.45, mix(a.z, b.z, k));
  camera.rotation.order = 'YXZ';
  camera.rotation.set(mix(a.pitch, b.pitch, k), mix(a.yaw, b.yaw, k), 0);
}
