import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

import { onHqSettings, roomName, signTitle, t as tr } from '../hq/i18n.js';
import { getActivityText } from '../office/components/ToolOverlay.js';
import { breakActivity, breakBubble, currentSpeakers } from '../office/engine/breaks.js';
import type { OfficeState } from '../office/engine/officeState.js';
import type { Character, OfficeLayout, ToolActivity } from '../office/types.js';
import { TILE_SIZE } from '../office/types.js';
import { buildStaticScene, pastel, WALL_HEIGHT } from './buildScene.js';
import type { Person } from './characters3d.js';
import { createPerson, posePerson } from './characters3d.js';
import type { PovController } from './povControls.js';
import { createPovController } from './povControls.js';
import { ISO_DURATION, isoTourFrame, povTourFrame } from './tour.js';

export type View3DMode = 'iso' | 'pov';

interface Office3DProps {
  officeState: OfficeState;
  agentTools: Record<number, ToolActivity[]>;
  alwaysShowLabels: boolean;
  mode: View3DMode;
  /** Date.now() when the guided tour started (tour.ts), null when not touring. */
  tourStart?: number | null;
}

const MAX_SPEECH = 42;
/** POV: labels show only for agents this close (tiles). */
const POV_LABEL_DISTANCE = 11;
const POV_PICK_DISTANCE = 8;
const POV_WALL_HEIGHT = 2.8;

/**
 * Agents HQ: 3D views of the office (prototype).
 *  - iso: voxel diorama from above. Left-drag pans, right-drag rotates, wheel zooms, click selects.
 *  - pov: first person in the same voxel style. Click to enter, WASD + mouse, E opens an agent.
 * Both read the same OfficeState the 2D engine updates and only render it.
 */
export function Office3D({ officeState, agentTools, alwaysShowLabels, mode, tourStart = null }: Office3DProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const toolsRef = useRef(agentTools);
  toolsRef.current = agentTools;
  const labelsRef = useRef(alwaysShowLabels);
  labelsRef.current = alwaysShowLabels;
  const tourRef = useRef(tourStart);
  tourRef.current = tourStart;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const pov = mode === 'pov';
    // One look everywhere: the voxel style (POV adds full-height walls and a ceiling).
    const style = 'voxel';

    // ── Renderer, scene, lights ──
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    host.appendChild(renderer.domElement);
    renderer.domElement.style.display = 'block';

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(pov ? '#262040' : '#140f26');
    if (pov) scene.fog = new THREE.Fog('#262040', 16, 38);
    scene.add(new THREE.HemisphereLight('#fff8ee', pov ? '#8a8070' : '#384058', pov ? 2.6 : 1.6));
    const sun = new THREE.DirectionalLight('#fff0d4', pov ? 1.3 : 2.2);
    sun.castShadow = true;
    sun.shadow.mapSize.set(4096, 4096);
    sun.shadow.bias = -0.0008;
    scene.add(sun, sun.target);

    // ── Camera + controls ──
    const ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 500);
    const persp = new THREE.PerspectiveCamera(72, 1, 0.05, 120);
    const camera: THREE.OrthographicCamera | THREE.PerspectiveCamera = pov ? persp : ortho;
    let controls: OrbitControls | null = null;
    if (!pov) {
      controls = new OrbitControls(ortho, renderer.domElement);
      controls.enableDamping = true;
      controls.screenSpacePanning = true;
      controls.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE };
      controls.touches = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_ROTATE };
      controls.minPolarAngle = 0.35;
      controls.maxPolarAngle = 1.15;
      controls.minZoom = 0.4;
      controls.maxZoom = 6;
    }

    const VIEW = 15; // ortho: world units visible vertically at zoom 1
    const resize = () => {
      const w = host.clientWidth || 1;
      const h = host.clientHeight || 1;
      renderer.setSize(w, h);
      const aspect = w / h;
      ortho.left = (-VIEW * aspect) / 2;
      ortho.right = (VIEW * aspect) / 2;
      ortho.top = VIEW / 2;
      ortho.bottom = -VIEW / 2;
      ortho.updateProjectionMatrix();
      persp.aspect = aspect;
      persp.updateProjectionMatrix();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(host);
    resize();

    // ── HTML overlay layer (labels, bubbles, room names, POV HUD) ──
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:absolute;inset:0;pointer-events:none;overflow:hidden';
    host.appendChild(overlay);

    let hud: HTMLDivElement | null = null;
    let hint: HTMLDivElement | null = null;
    let crosshair: HTMLDivElement | null = null;
    if (pov) {
      hud = document.createElement('div');
      hud.className = 'pixel-panel';
      hud.style.cssText = 'position:absolute;top:8px;right:8px;padding:6px 14px;font-size:14px;font-weight:600;display:flex;gap:14px';
      crosshair = document.createElement('div');
      crosshair.style.cssText =
        'position:absolute;left:50%;top:50%;width:8px;height:8px;margin:-4px 0 0 -4px;border-radius:50%;background:#fff;box-shadow:0 0 0 2px rgba(0,0,0,.45)';
      hint = document.createElement('div');
      hint.className = 'pixel-panel';
      hint.style.cssText =
        'position:absolute;left:50%;bottom:90px;transform:translateX(-50%);padding:8px 16px;font-size:15px;font-weight:600;text-align:center;line-height:1.35';
      hint.innerHTML = `${tr('povEnter')}<br><span style="opacity:.75;font-size:14px">${tr('povHelp')}</span>`;
      overlay.append(hud, crosshair, hint);
    }

    // ── Static office, rebuilt when the layout object, language or company name changes ──
    let staticLayout: OfficeLayout | null = null;
    let settingsChanged = false;
    void document.fonts?.ready.then(() => {
      settingsChanged = true;
    });
    const unsubscribeSettings = onHqSettings(() => {
      settingsChanged = true;
      hudKey = '';
      if (hint) hint.innerHTML = `${tr('povEnter')}<br><span style="opacity:.75;font-size:14px">${tr('povHelp')}</span>`;
    });
    let staticGroup: THREE.Group | null = null;
    const roomLabels = new Map<string, { el: HTMLDivElement; pos: THREE.Vector3 }>();
    const rebuildStatic = (layout: OfficeLayout) => {
      if (staticGroup) scene.remove(staticGroup);
      const built = buildStaticScene(
        layout,
        {
          style: 'voxel',
          wallHeight: pov ? POV_WALL_HEIGHT : WALL_HEIGHT,
          ceiling: pov,
          signTitle: signTitle(),
          signSubtitle: tr('by'),
          roomName,
        },
      );
      staticGroup = built.group;
      scene.add(staticGroup);
      if (!staticLayout && controls) {
        controls.target.set(built.center.x, 0, built.center.z * 0.62);
        ortho.position.copy(controls.target).add(new THREE.Vector3(30, 42, 34));
        ortho.zoom = 0.62; // open wide enough to see several rooms at once
        ortho.updateProjectionMatrix();
      }
      const span = Math.max(built.size.cols, built.size.rows);
      sun.position.set(built.center.x - span * 0.4, span * 0.9, built.center.z - span * 0.25);
      sun.target.position.copy(built.center);
      const sc = sun.shadow.camera;
      sc.left = -span * 0.8;
      sc.right = span * 0.8;
      sc.top = span * 0.8;
      sc.bottom = -span * 0.8;
      sc.near = 1;
      sc.far = span * 3;
      sc.updateProjectionMatrix();

      for (const { el } of roomLabels.values()) el.remove();
      roomLabels.clear();
      if (!pov) {
        const { areaTiles, areas, cols, rows } = layout;
        for (const area of areas ?? []) {
          let minCol = Infinity;
          let maxRow = -Infinity;
          for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
              if (areaTiles?.[r * cols + c] !== area.label) continue;
              minCol = Math.min(minCol, c);
              maxRow = Math.max(maxRow, r);
            }
          }
          if (!Number.isFinite(minCol)) continue;
          const el = document.createElement('div');
          el.className = 'pixel-panel';
          el.style.cssText = `position:absolute;white-space:nowrap;padding:2px 10px;font-size:13px;font-weight:650;border-left:4px solid ${area.color};transform:translate(0,-50%)`;
          el.textContent = roomName(area.label);
          overlay.appendChild(el);
          roomLabels.set(area.label, { el, pos: new THREE.Vector3(minCol - 0.6, WALL_HEIGHT, maxRow + 1.6) });
        }
      }
      staticLayout = layout;
    };

    // ── People ──
    const people = new Map<number, Person>();
    const labels = new Map<number, { el: HTMLDivElement; key: string }>();
    const bubbles = new Map<number, { el: HTMLDivElement; key: string }>();
    const meshOwner = new Map<THREE.Object3D, number>();

    /** POV: each agent wears its project's color (the Area of its desk). */
    const projectColor = (ch: Character): string => {
      const owner = ch.isSubagent && ch.parentAgentId !== null ? officeState.characters.get(ch.parentAgentId) : ch;
      const zone = owner?.seatId ? officeState.seatZone(owner.seatId) : null;
      const color = zone ? officeState.getLayout().areas?.find((a) => a.label === zone)?.color : undefined;
      return color ? pastel(color, 0.12) : '#8fb8e8';
    };

    const removePerson = (id: number) => {
      const p = people.get(id);
      if (p) {
        scene.remove(p.root);
        p.root.traverse((o) => meshOwner.delete(o));
      }
      people.delete(id);
      labels.get(id)?.el.remove();
      labels.delete(id);
      bubbles.get(id)?.el.remove();
      bubbles.delete(id);
    };

    const syncPeople = () => {
      const alive = new Set<number>();
      for (const ch of officeState.characters.values()) {
        alive.add(ch.id);
        let p = people.get(ch.id);
        if (p && (p.palette !== ch.palette || p.hueShift !== ch.hueShift)) {
          removePerson(ch.id);
          p = undefined;
        }
        if (!p) {
          p = createPerson(ch, style, projectColor(ch));
          people.set(ch.id, p);
          scene.add(p.root);
          p.root.traverse((o) => meshOwner.set(o, ch.id));
        }
      }
      for (const id of [...people.keys()]) if (!alive.has(id)) removePerson(id);
    };

    // ── Projection helpers ──
    const v = new THREE.Vector3();
    /** Screen position, or null when the point is behind the camera / off screen. */
    const toScreen = (pos: THREE.Vector3): { x: number; y: number } | null => {
      v.copy(pos).project(camera);
      if (v.z > 1 || v.z < -1 || Math.abs(v.x) > 1.2 || Math.abs(v.y) > 1.2) return null;
      return { x: ((v.x + 1) / 2) * host.clientWidth, y: ((1 - v.y) / 2) * host.clientHeight };
    };
    const place = (el: HTMLElement, pos: THREE.Vector3): boolean => {
      const s = toScreen(pos);
      if (!s) return false;
      el.style.left = `${s.x}px`;
      el.style.top = `${s.y}px`;
      return true;
    };
    /** Label scale for a world point: zoom-based from above, distance-based in POV (0 = hide). */
    let isoScale = 1;
    const scaleAt = (pos: THREE.Vector3): number => {
      if (!pov) return isoScale;
      const d = camera.position.distanceTo(pos);
      if (d > POV_LABEL_DISTANCE) return 0;
      return Math.min(1, Math.max(0.45, 3.2 / d));
    };

    const labelText = (ch: Character): string => {
      let activity = getActivityText(
        ch.id,
        toolsRef.current,
        ch.isActive,
        ch.bubbleType,
        ch.waitingAwaitingInput ?? false,
      );
      if (activity === 'Idle' && ch.breakState?.arrived) {
        activity = breakActivity(ch.breakState.kind);
      }
      if (activity === 'Idle') activity = tr('idle');
      else if (activity === 'Waiting for input') activity = tr('done');
      const title = officeState.agentTitles.get(ch.id) ?? '';
      return `${activity}\n${title}\n${ch.folderName ?? ''}`;
    };

    const updateLabel = (ch: Character, head: THREE.Vector3, hovered: boolean) => {
      const selected = officeState.selectedAgentId === ch.id;
      const scale = scaleAt(head);
      const show =
        !ch.isSubagent &&
        scale > 0 &&
        (pov || labelsRef.current || selected || hovered || officeState.hoveredAgentId === ch.id);
      let entry = labels.get(ch.id);
      if (!show) {
        if (entry) entry.el.style.display = 'none';
        return;
      }
      if (!entry) {
        const el = document.createElement('div');
        el.className = 'pixel-panel';
        el.style.cssText =
          'position:absolute;padding:2px 8px 4px;white-space:nowrap;max-width:260px;line-height:1.05;transform-origin:50% 100%';
        overlay.appendChild(el);
        entry = { el, key: '' };
        labels.set(ch.id, entry);
      }
      if (!place(entry.el, head)) {
        entry.el.style.display = 'none';
        return;
      }
      entry.el.style.display = '';
      entry.el.style.transform = `translate(-50%,-100%) scale(${scale})`;
      entry.el.style.opacity = selected || hovered ? '1' : '0.85';
      entry.el.style.zIndex = selected || hovered ? '3' : '1';
      entry.el.style.outline = hovered ? '2px solid #ffd84a' : '';
      const key = labelText(ch);
      if (key !== entry.key) {
        entry.key = key;
        const [activity, title, folder] = key.split('\n');
        entry.el.innerHTML = '';
        const a = document.createElement('div');
        a.style.cssText = `font-size:14px;font-weight:700;${ch.isActive ? 'color:#c6f05a' : ''}`;
        a.textContent = activity;
        entry.el.appendChild(a);
        if (title) {
          const t = document.createElement('div');
          t.style.cssText = 'font-size:13px;color:#d8ccff;overflow:hidden;text-overflow:ellipsis';
          t.textContent = title;
          entry.el.appendChild(t);
        }
        if (folder) {
          const f = document.createElement('div');
          f.style.cssText = 'font-size:11px;opacity:.7';
          f.textContent = folder;
          entry.el.appendChild(f);
        }
      }
    };

    const setBubble = (id: number, text: string | null, speech: boolean, at: THREE.Vector3 | null) => {
      let entry = bubbles.get(id);
      const scale = at ? scaleAt(at) : 0;
      if (!text || !at || scale === 0) {
        if (entry) entry.el.style.display = 'none';
        return;
      }
      if (!entry) {
        const el = document.createElement('div');
        el.style.cssText = 'position:absolute;white-space:nowrap;transform-origin:0 50%';
        overlay.appendChild(el);
        entry = { el, key: '' };
        bubbles.set(id, entry);
      }
      if (!place(entry.el, at)) {
        entry.el.style.display = 'none';
        return;
      }
      entry.el.style.display = '';
      entry.el.style.transform = `translate(0,-50%) scale(${scale})`;
      const key = `${speech}|${text}`;
      if (key !== entry.key) {
        entry.key = key;
        entry.el.className = speech ? 'pixel-panel' : '';
        entry.el.style.padding = speech ? '2px 8px' : '0';
        entry.el.style.fontSize = speech ? '13px' : '18px';
        entry.el.style.color = text.startsWith('Z') ? '#c9d3ff' : '';
        entry.el.textContent = text;
      }
    };

    // ── Picking ──
    const raycaster = new THREE.Raycaster();
    const pickAt = (ndc: THREE.Vector2, maxDistance = Infinity): number | null => {
      raycaster.setFromCamera(ndc, camera);
      raycaster.far = maxDistance;
      const hit = raycaster.intersectObjects(
        [...people.values()].map((p) => p.root),
        true,
      )[0];
      return hit ? (meshOwner.get(hit.object) ?? null) : null;
    };

    let povController: PovController | null = null;
    let downAt: { x: number; y: number } | null = null;
    const onDown = (e: PointerEvent) => {
      downAt = { x: e.clientX, y: e.clientY };
    };
    const onUp = (e: PointerEvent) => {
      if (!downAt || e.button !== 0) return;
      const moved = Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y);
      downAt = null;
      if (moved > 5) return;
      const rect = renderer.domElement.getBoundingClientRect();
      const id = pickAt(
        new THREE.Vector2(
          ((e.clientX - rect.left) / rect.width) * 2 - 1,
          -((e.clientY - rect.top) / rect.height) * 2 + 1,
        ),
      );
      officeState.selectedAgentId = id;
    };
    const onContextMenu = (e: Event) => e.preventDefault();
    // Top-down view: hovering an agent shows its label (when labels are off).
    let isoHovered: number | null = null;
    let lastHoverCheck = 0;
    const onMove = (e: PointerEvent) => {
      const nowMs = performance.now();
      if (nowMs - lastHoverCheck < 50) return;
      lastHoverCheck = nowMs;
      const rect = renderer.domElement.getBoundingClientRect();
      isoHovered = pickAt(
        new THREE.Vector2(
          ((e.clientX - rect.left) / rect.width) * 2 - 1,
          -((e.clientY - rect.top) / rect.height) * 2 + 1,
        ),
      );
      renderer.domElement.style.cursor = isoHovered !== null ? 'pointer' : '';
    };
    if (pov) {
      // The layout has to exist before the controller picks a start tile.
      rebuildStatic(officeState.getLayout());
      povController = createPovController(
        persp,
        renderer.domElement,
        officeState,
        () => pickAt(new THREE.Vector2(0, 0), POV_PICK_DISTANCE),
        (id) => {
          officeState.selectedAgentId = id;
        },
      );
    } else {
      renderer.domElement.addEventListener('pointerdown', onDown);
      renderer.domElement.addEventListener('pointerup', onUp);
      renderer.domElement.addEventListener('pointermove', onMove);
    }
    renderer.domElement.addEventListener('contextmenu', onContextMenu);

    // ── Frame loop ──
    let raf = 0;
    const clock = new THREE.Clock();
    const head = new THREE.Vector3();
    const side = new THREE.Vector3();
    const sideOffset = new THREE.Vector3(0.35, -0.1, 0);
    let hudKey = '';
    const frame = () => {
      raf = requestAnimationFrame(frame);
      const dt = Math.min(clock.getDelta(), 0.1);
      const t = clock.elapsedTime;
      const layout = officeState.getLayout();
      if (layout !== staticLayout || settingsChanged) {
        settingsChanged = false;
        rebuildStatic(layout);
      }
      syncPeople();
      const tourStart = tourRef.current;
      if (tourStart !== null) {
        const tourT = (Date.now() - tourStart) / 1000;
        if (pov) povTourFrame(Math.max(0, tourT - ISO_DURATION), layout, persp);
        else if (controls) isoTourFrame(tourT, layout, ortho, controls.target);
      } else {
        controls?.update();
        povController?.update(dt);
      }
      isoScale = Math.min(1, Math.max(0.5, ortho.zoom * 0.8));

      const locked = povController?.isLocked() ?? false;
      const hovered = pov ? (locked ? pickAt(new THREE.Vector2(0, 0), POV_PICK_DISTANCE) : null) : isoHovered;
      if (hint) hint.style.display = locked || tourRef.current !== null ? 'none' : '';
      if (crosshair && tourRef.current !== null) crosshair.style.display = 'none';
      if (crosshair) crosshair.style.background = hovered !== null ? '#c6f05a' : '#fff';

      let waiting = 0;
      let working = 0;
      for (const ch of officeState.characters.values()) {
        if (ch.isSubagent) continue;
        if (ch.bubbleType === 'permission' || officeState.agentRawStatus.get(ch.id) === 'blocked') waiting++;
        else if (ch.isActive) working++;
      }
      const now = Date.now();
      const speakers = currentSpeakers(officeState.characters.values(), layout, now);

      if (hud) {
        const key = `${waiting}|${working}|${tr('hudWorking')}`;
        if (key !== hudKey) {
          hudKey = key;
          hud.innerHTML = `<span style="color:${waiting ? '#ff8f6b' : 'inherit'}">● ${tr('hudWaiting', { n: waiting })}</span><span style="color:#c6f05a">● ${tr('hudWorking', { n: working })}</span>`;
        }
      }

      for (const ch of officeState.characters.values()) {
        const p = people.get(ch.id);
        if (!p) continue;
        const isHovered = hovered === ch.id;
        posePerson(p, ch, t, officeState.selectedAgentId === ch.id || isHovered);
        const napping = ch.breakState?.arrived && ch.breakState.kind === 'nap';
        const height = pov ? 1.2 * p.scale : 1.15 * p.scale;
        head.set(ch.x / TILE_SIZE, napping ? 0.9 : ch.state === 'type' ? height * 0.82 : height, ch.y / TILE_SIZE);
        if (napping) head.z -= 0.6;
        updateLabel(ch, head, isHovered);

        side.copy(head).add(sideOffset);
        const bubble = breakBubble(ch, speakers.has(ch.id), officeState.agentTitles.get(ch.id), now, MAX_SPEECH);
        setBubble(ch.id, bubble?.text ?? null, bubble?.speech ?? false, bubble ? side : null);
      }
      for (const { el, pos } of roomLabels.values()) {
        el.style.display = place(el, pos) ? '' : 'none';
      }
      renderer.render(scene, camera);
    };
    frame();

    return () => {
      unsubscribeSettings();
      cancelAnimationFrame(raf);
      ro.disconnect();
      controls?.dispose();
      povController?.dispose();
      renderer.domElement.removeEventListener('pointerdown', onDown);
      renderer.domElement.removeEventListener('pointerup', onUp);
      renderer.domElement.removeEventListener('pointermove', onMove);
      renderer.domElement.removeEventListener('contextmenu', onContextMenu);
      renderer.dispose();
      host.innerHTML = '';
    };
  }, [officeState, mode]);

  return <div ref={hostRef} className="absolute inset-0" style={{ zIndex: 5 }} data-testid="office-3d" />;
}
