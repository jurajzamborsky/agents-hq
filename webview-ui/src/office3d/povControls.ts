/**
 * Agents HQ POV: first-person walking through the office.
 *
 * Click the view to capture the mouse (pointer lock), WASD / arrows to walk,
 * Shift to hurry, mouse to look around, E or click to open the agent under
 * the crosshair, Esc to get the cursor back. Collisions use the 2D engine's
 * tile map: walls, void and furniture-blocked tiles cannot be entered.
 */

import * as THREE from 'three';

import type { OfficeState } from '../office/engine/officeState.js';

const EYE_HEIGHT = 1.45;
const WALK_SPEED = 3.2; // tiles per second
const RUN_MULTIPLIER = 1.8;
const BODY_RADIUS = 0.22;
const LOOK_SENSITIVITY = 0.0022;
const WALL = 0;
const VOID = 255;

export interface PovController {
  update(dt: number): void;
  dispose(): void;
  isLocked(): boolean;
}

export function createPovController(
  camera: THREE.PerspectiveCamera,
  dom: HTMLElement,
  officeState: OfficeState,
  pickAgent: () => number | null,
  onSelect: (id: number) => void,
): PovController {
  let yaw = Math.PI; // facing +z (south) along the corridor
  let pitch = -0.08;
  const keys = new Set<string>();

  // Start in the corridor near the top.
  const start = findStart(officeState);
  camera.position.set(start.x, EYE_HEIGHT, start.z);
  camera.rotation.order = 'YXZ';

  const locked = () => document.pointerLockElement === dom;

  const onClick = () => {
    if (!locked()) {
      void dom.requestPointerLock();
      return;
    }
    const id = pickAgent();
    if (id !== null) select(id);
  };
  const select = (id: number) => {
    onSelect(id);
    // Free the cursor so the detail panel buttons can be used.
    document.exitPointerLock();
  };
  const onMouseMove = (e: MouseEvent) => {
    if (!locked()) return;
    yaw -= e.movementX * LOOK_SENSITIVITY;
    pitch -= e.movementY * LOOK_SENSITIVITY;
    pitch = Math.max(-1.3, Math.min(1.3, pitch));
  };
  const isTyping = () => {
    const el = document.activeElement;
    return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (isTyping()) return;
    keys.add(e.code);
    if (e.code === 'KeyE') {
      const id = pickAgent();
      if (id !== null) select(id);
    }
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
  };
  const onKeyUp = (e: KeyboardEvent) => keys.delete(e.code);
  const onBlur = () => keys.clear();

  dom.addEventListener('click', onClick);
  document.addEventListener('mousemove', onMouseMove);
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);

  const free = (x: number, z: number): boolean => {
    for (const [dx, dz] of [
      [-BODY_RADIUS, -BODY_RADIUS],
      [BODY_RADIUS, -BODY_RADIUS],
      [-BODY_RADIUS, BODY_RADIUS],
      [BODY_RADIUS, BODY_RADIUS],
    ]) {
      const c = Math.floor(x + dx);
      const r = Math.floor(z + dz);
      const row = officeState.tileMap[r];
      const tile = row?.[c];
      if (tile === undefined || tile === WALL || tile === VOID) return false;
      if (officeState.blockedTiles.has(`${c},${r}`)) return false;
    }
    return true;
  };

  const forward = new THREE.Vector3();
  const right = new THREE.Vector3();
  return {
    update(dt: number) {
      camera.rotation.set(pitch, yaw, 0);
      let f = 0;
      let s = 0;
      if (keys.has('KeyW') || keys.has('ArrowUp')) f += 1;
      if (keys.has('KeyS') || keys.has('ArrowDown')) f -= 1;
      if (keys.has('KeyD') || keys.has('ArrowRight')) s += 1;
      if (keys.has('KeyA') || keys.has('ArrowLeft')) s -= 1;
      if (!f && !s) return;
      const speed = WALK_SPEED * (keys.has('ShiftLeft') || keys.has('ShiftRight') ? RUN_MULTIPLIER : 1) * dt;
      forward.set(-Math.sin(yaw), 0, -Math.cos(yaw));
      right.set(Math.cos(yaw), 0, -Math.sin(yaw));
      const len = Math.hypot(f, s);
      const dx = ((forward.x * f + right.x * s) / len) * speed;
      const dz = ((forward.z * f + right.z * s) / len) * speed;
      // Slide along walls: try each axis separately.
      if (free(camera.position.x + dx, camera.position.z)) camera.position.x += dx;
      if (free(camera.position.x, camera.position.z + dz)) camera.position.z += dz;
    },
    dispose() {
      dom.removeEventListener('click', onClick);
      document.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      if (locked()) document.exitPointerLock();
    },
    isLocked: locked,
  };
}

/** First walkable tile with no Area (the corridor), scanning from the top. */
function findStart(officeState: OfficeState): { x: number; z: number } {
  const layout = officeState.getLayout();
  for (let r = 2; r < layout.rows; r++) {
    for (let c = 0; c < layout.cols; c++) {
      const t = layout.tiles[r * layout.cols + c];
      if (t === WALL || t === VOID) continue;
      if (layout.areaTiles?.[r * layout.cols + c]) continue;
      if (officeState.blockedTiles.has(`${c},${r}`)) continue;
      return { x: c + 1.5 < layout.cols ? c + 1.5 : c + 0.5, z: r + 0.5 };
    }
  }
  return { x: layout.cols / 2, z: layout.rows / 2 };
}
