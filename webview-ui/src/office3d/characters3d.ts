/**
 * Agents HQ 3D: voxel people. Positions, facing and state come from the 2D
 * engine's Character objects every frame; this only poses the boxes.
 */

import * as THREE from 'three';

import type { Character } from '../office/types.js';
import { CharacterState, Direction, TILE_SIZE } from '../office/types.js';

/** People are a bit larger than a tile so they read well from above. */
export const PERSON_SCALE = 1.3;
const unitBox = new THREE.BoxGeometry(1, 1, 1);
/** Limb geometry hangs below its origin so rotation pivots at the shoulder/hip. */
const limbBox = new THREE.BoxGeometry(1, 1, 1).translate(0, -0.5, 0);
const mats = new Map<string, THREE.MeshLambertMaterial>();
function mat(color: string, opacity = 1): THREE.MeshLambertMaterial {
  const key = `${color}/${opacity}`;
  let m = mats.get(key);
  if (!m) {
    m = new THREE.MeshLambertMaterial({ color, transparent: opacity < 1, opacity });
    mats.set(key, m);
  }
  return m;
}

/** Shirt / pants / hair / skin per base palette (matches the 6 sprite skins loosely). */
const PALETTES = [
  { shirt: '#3f7bd6', pants: '#2c3446', hair: '#3a2618', skin: '#f0c7a0' },
  { shirt: '#d64f3f', pants: '#3b3b44', hair: '#1d1a19', skin: '#c98e63' },
  { shirt: '#4caf6a', pants: '#2e3a52', hair: '#a8642e', skin: '#f3d0b0' },
  { shirt: '#f0b43c', pants: '#394150', hair: '#2b211c', skin: '#8d5a3b' },
  { shirt: '#9a5ad6', pants: '#2a2f3a', hair: '#e2c26a', skin: '#efc29b' },
  { shirt: '#e8e6e1', pants: '#30394d', hair: '#5a3a24', skin: '#d9a57d' },
];

function shiftHue(hex: string, degrees: number): string {
  if (!degrees) return hex;
  const c = new THREE.Color(hex);
  const hsl = { h: 0, s: 0, l: 0 };
  c.getHSL(hsl);
  c.setHSL((hsl.h + degrees / 360) % 1, hsl.s, hsl.l);
  return `#${c.getHexString()}`;
}

export interface Person {
  root: THREE.Group;
  body: THREE.Group;
  legL: THREE.Mesh;
  legR: THREE.Mesh;
  armL: THREE.Mesh;
  armR: THREE.Mesh;
  mug: THREE.Mesh;
  ring: THREE.Mesh;
  palette: number;
  hueShift: number;
  /** Leg pivot height in body space, and the root scale — used by poses. */
  hipY: number;
  scale: number;
}

function part(
  parent: THREE.Object3D,
  w: number,
  h: number,
  d: number,
  x: number,
  y: number,
  z: number,
  color: string,
  opacity: number,
): THREE.Mesh {
  const m = new THREE.Mesh(unitBox, mat(color, opacity));
  m.scale.set(w, h, d);
  m.position.set(x, y, z);
  m.castShadow = true;
  parent.add(m);
  return m;
}

/** Limbs pivot at the top: geometry hangs below the mesh origin. */
function limb(parent: THREE.Object3D, w: number, h: number, x: number, y: number, color: string, opacity: number) {
  const pivot = new THREE.Mesh(limbBox, mat(color, opacity));
  pivot.scale.set(w, h, w);
  pivot.position.set(x, y, 0);
  pivot.castShadow = true;
  parent.add(pivot);
  return pivot;
}

/**
 * Soft (POV) style: a round blob in the project's color, little eyes, stubby
 * arms and feet — same Person rig, so posePerson animates both styles.
 */
function createBlob(ch: Character, color: string): Person {
  const opacity = ch.isSubagent ? 0.8 : 1;
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);
  const capsule = (r: number, len: number, c: string) => {
    const m = new THREE.Mesh(new THREE.CapsuleGeometry(r, len, 6, 14), mat(c, opacity));
    m.castShadow = true;
    return m;
  };
  const dark = `#${new THREE.Color(color).multiplyScalar(0.7).getHexString()}`;
  const legL = limb(body, 0.11, 0.2, -0.1, 0.22, dark, opacity);
  const legR = limb(body, 0.11, 0.2, 0.1, 0.22, dark, opacity);
  const trunk = capsule(0.26, 0.32, color);
  trunk.position.set(0, 0.55, 0);
  body.add(trunk);
  const armL = limb(body, 0.08, 0.24, -0.29, 0.58, color, opacity);
  const armR = limb(body, 0.08, 0.24, 0.29, 0.58, color, opacity);
  for (const x of [-0.09, 0.09]) {
    const eyeWhite = new THREE.Mesh(new THREE.SphereGeometry(0.065, 12, 8), mat('#ffffff', opacity));
    eyeWhite.position.set(x, 0.72, 0.22);
    const pupil = new THREE.Mesh(new THREE.SphereGeometry(0.035, 10, 6), mat('#1f1f24', opacity));
    pupil.position.set(x, 0.72, 0.275);
    body.add(eyeWhite, pupil);
  }
  const cheek = mat('#ff9aa8', opacity);
  for (const x of [-0.17, 0.17]) {
    const c = new THREE.Mesh(new THREE.SphereGeometry(0.035, 8, 6), cheek);
    c.position.set(x, 0.64, 0.22);
    body.add(c);
  }

  const mug = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.1, 12), mat('#f1efe9'));
  mug.position.set(0.3, 0.36, 0.12);
  mug.visible = false;
  body.add(mug);
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.32, 0.4, 24),
    new THREE.MeshBasicMaterial({ color: '#ffd84a', side: THREE.DoubleSide }),
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.02;
  ring.visible = false;
  root.add(ring);
  root.scale.setScalar(ch.isSubagent ? 0.7 : 1.15);
  return {
    root, body, legL, legR, armL, armR, mug, ring,
    palette: ch.palette, hueShift: ch.hueShift,
    hipY: 0.22, scale: root.scale.x,
  };
}

export function createPerson(ch: Character, style: 'voxel' | 'soft' = 'voxel', color = '#7fb3e8'): Person {
  if (style === 'soft') return createBlob(ch, color);
  const p = PALETTES[ch.palette % PALETTES.length];
  const shirt = shiftHue(p.shirt, ch.hueShift);
  const opacity = ch.isSubagent ? 0.75 : 1;
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);

  const legL = limb(body, 0.13, 0.32, -0.08, 0.32, p.pants, opacity);
  const legR = limb(body, 0.13, 0.32, 0.08, 0.32, p.pants, opacity);
  part(body, 0.36, 0.34, 0.22, 0, 0.49, 0, shirt, opacity); // torso
  const armL = limb(body, 0.1, 0.3, -0.23, 0.64, shirt, opacity);
  const armR = limb(body, 0.1, 0.3, 0.23, 0.64, shirt, opacity);
  part(body, 0.3, 0.28, 0.28, 0, 0.8, 0, p.skin, opacity); // head
  part(body, 0.32, 0.08, 0.3, 0, 0.97, -0.01, p.hair, opacity); // hair top
  part(body, 0.32, 0.16, 0.06, 0, 0.88, -0.14, p.hair, opacity); // hair back
  part(body, 0.05, 0.05, 0.02, -0.07, 0.82, 0.145, '#222222', opacity); // eyes
  part(body, 0.05, 0.05, 0.02, 0.07, 0.82, 0.145, '#222222', opacity);

  const mug = new THREE.Mesh(unitBox, mat('#f1efe9'));
  mug.scale.set(0.09, 0.11, 0.09);
  mug.position.set(0.26, 0.4, 0.12);
  mug.visible = false;
  body.add(mug);

  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.32, 0.4, 24),
    new THREE.MeshBasicMaterial({ color: '#ffd84a', side: THREE.DoubleSide }),
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.02;
  ring.visible = false;
  root.add(ring);

  root.scale.setScalar((ch.isSubagent ? 0.72 : 1) * PERSON_SCALE);
  return {
    root, body, legL, legR, armL, armR, mug, ring,
    palette: ch.palette, hueShift: ch.hueShift,
    hipY: 0.32, scale: root.scale.x,
  };
}

const FACING: Record<number, number> = {
  [Direction.DOWN]: 0,
  [Direction.UP]: Math.PI,
  [Direction.LEFT]: -Math.PI / 2,
  [Direction.RIGHT]: Math.PI / 2,
};

/** Pose a person from its character state. `t` is elapsed seconds. */
export function posePerson(person: Person, ch: Character, t: number, selected: boolean): void {
  const { root, body, legL, legR, armL, armR, mug } = person;
  root.position.set(ch.x / TILE_SIZE, 0, ch.y / TILE_SIZE);
  root.rotation.set(0, FACING[ch.dir] ?? 0, 0);
  body.position.set(0, 0, 0);
  body.rotation.set(0, 0, 0);
  legL.rotation.set(0, 0, 0);
  legR.rotation.set(0, 0, 0);
  armL.rotation.set(0, 0, 0);
  armR.rotation.set(0, 0, 0);
  mug.visible = false;
  person.ring.visible = selected;

  const br = ch.breakState;
  const phase = t * 9 + ch.id;

  if (br?.arrived && br.kind === 'nap') {
    // Lying on the bed, head on the pillow (beds have their headboard north).
    root.rotation.set(0, 0, 0);
    body.rotation.x = -Math.PI / 2;
    body.position.set(0, 0.62 / person.scale, -0.1);
    body.position.y += Math.sin(t * 1.4 + ch.id) * 0.01; // breathing
    armL.rotation.x = 0.1;
    armR.rotation.x = 0.1;
    return;
  }

  // Activity poses at break spots (gym, game room, phone booth, shower).
  const pose = br?.arrived ? br.spot.pose : null;
  if (pose === 'run') {
    const swing = Math.sin(t * 14 + ch.id) * 0.7;
    legL.rotation.x = swing;
    legR.rotation.x = -swing;
    armL.rotation.x = -swing * 0.9;
    armR.rotation.x = swing * 0.9;
    body.position.y = 0.16 / person.scale + Math.abs(Math.sin(t * 14 + ch.id)) * 0.05; // on the belt
    return;
  }
  if (pose === 'lift') {
    const up = (Math.sin(t * 3 + ch.id) + 1) / 2;
    armL.rotation.x = Math.PI - 0.2 - up * 1.2;
    armR.rotation.x = Math.PI - 0.2 - up * 1.2;
    body.position.y = -up * 0.03;
    return;
  }
  if (pose === 'play') {
    armR.rotation.x = -0.9 + Math.sin(t * 7 + ch.id) * 0.6;
    armL.rotation.x = -0.4;
    body.position.y = Math.abs(Math.sin(t * 3.5 + ch.id)) * 0.03;
    return;
  }
  if (pose === 'phone') {
    armR.rotation.x = -2.5; // receiver at the ear
    armR.rotation.z = -0.35;
    body.rotation.y = Math.sin(t * 0.7 + ch.id) * 0.15;
    return;
  }
  if (pose === 'shower') {
    armL.rotation.x = Math.PI - 0.4 + Math.sin(t * 5) * 0.3;
    armR.rotation.x = Math.PI - 0.4 - Math.sin(t * 5) * 0.3;
    return;
  }

  switch (ch.state) {
    case CharacterState.WALK: {
      const swing = Math.sin(phase) * 0.6;
      legL.rotation.x = swing;
      legR.rotation.x = -swing;
      armL.rotation.x = -swing * 0.8;
      armR.rotation.x = swing * 0.8;
      body.position.y = Math.abs(Math.sin(phase)) * 0.04;
      break;
    }
    case CharacterState.TYPE: {
      // Seated: lower the body onto the chair, legs forward.
      // Hips (leg pivot at local y 0.32) on the chair seat (~0.46 world).
      body.position.y = 0.46 / person.scale - person.hipY;
      legL.rotation.x = -Math.PI / 2;
      legR.rotation.x = -Math.PI / 2;
      if (ch.isActive) {
        const tap = Math.sin(t * 18 + ch.id) * 0.15;
        armL.rotation.x = -1.2 + tap;
        armR.rotation.x = -1.2 - tap;
      } else {
        armL.rotation.x = -0.3;
        armR.rotation.x = -0.3;
      }
      break;
    }
    default: {
      // Standing; at the coffee machine or a kitchen table, hold a mug.
      if (br?.arrived && (br.kind === 'coffee' || br.kind === 'chat')) {
        mug.visible = true;
        armR.rotation.x = -1.0 + Math.max(0, Math.sin(t * 0.8 + ch.id)) * -0.5;
      }
      body.position.y = Math.sin(t * 2 + ch.id) * 0.008;
    }
  }
}
