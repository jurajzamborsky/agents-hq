/**
 * Agents HQ server: serves the office UI and drives it from the agents that
 * run on this machine (see sources/).
 *
 * Security model (see README.md):
 *  - binds to 127.0.0.1 only, there is no option to change that;
 *  - every WebSocket connection needs the per-start random token, a loopback
 *    Host header (DNS-rebinding guard) and a same-origin (or absent) Origin;
 *  - the browser can only ask for: an agent's recent output (read), bringing
 *    its terminal to the front (herdr source only) and its own
 *    display settings. No message types into an agent, starts or stops one,
 *    or writes anywhere outside ~/.agents-hq;
 *  - state lives in ~/.agents-hq (0700 dir, 0600 files). Nothing is written
 *    to ~/.claude or ~/.codex, no hooks are installed, nothing leaves the machine.
 */

import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import * as crypto from 'crypto';
import Fastify from 'fastify';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { AssetCache } from './assets.js';
import { generateRoomsLayout, RoomRegistry } from './rooms.js';
import type { AgentSnapshot, AgentSource, AgentStatus } from './sources/index.js';

type Message = Record<string, unknown>;
type Send = (message: Message) => void;

const POLL_INTERVAL_MS = 1500;
const MAX_WS_PAYLOAD_BYTES = 2 * 1024 * 1024;
export const DATA_DIR = path.join(os.homedir(), '.agents-hq');
const WORK_TOOL_PREFIX = 'hub-work-';
const SUB_TOOL_PREFIX = 'hub-sub-';
/** Idle this long → the agent goes for a nap in the shared napping room. */
const NAP_AFTER_MS = (Number(process.env.HQ_NAP_MINUTES) || 15) * 60_000;
const isIdleStatus = (status: AgentStatus) => status !== 'working' && status !== 'blocked';
/** A work stretch this long earns a shower afterwards. */
const SHOWER_AFTER_MS = (Number(process.env.HQ_SHOWER_MINUTES) || 30) * 60_000;
const COMPANY_NAME_MAX = 40;
const LANGUAGES = new Set(['sk', 'en']);

// ── Persistence (~/.agents-hq) ──────────────────────────────

function ensureDataDir(): void {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  fs.chmodSync(DATA_DIR, 0o700);
}

function readJson<T>(name: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA_DIR, name), 'utf-8')) as T;
  } catch {
    return fallback;
  }
}

function writeJson(name: string, value: unknown): void {
  const file = path.join(DATA_DIR, name);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

interface Settings {
  soundEnabled: boolean;
  alwaysShowLabels: boolean;
  showAreas: boolean;
  lastSeenVersion: string;
  /** Printed on the lobby sign: "<company> Agents HQ". */
  companyName: string;
  language: 'sk' | 'en';
}

const DEFAULT_SETTINGS: Settings = {
  soundEnabled: true,
  alwaysShowLabels: true,
  showAreas: false,
  lastSeenVersion: '',
  companyName: '',
  language: 'sk',
};

type SeatMeta = { palette?: number; hueShift?: number; seatId?: string };

// ── Agent model ────────────────────────────────────────────────

interface OfficeAgent {
  id: number;
  key: string;
  project: string;
  kind: string;
  canFocus: boolean;
  title: string;
  status: AgentStatus;
  /** Live spinner line while working, e.g. "Waiting for 3 background agents". */
  activity: string;
  workToolSeq: number;
  /** Subagent rows currently shown, by stable slot id. */
  subagents: Map<string, string>;
  /** When the agent last stopped working (null while working). Agents that
   *  are already idle when the server starts count from the start. */
  idleSince: number | null;
  napping: boolean;
  /** Current work stretch: when it started and whether subagents ran in it. */
  workSince: number | null;
  usedSubagents: boolean;
}

export interface OfficeServerOptions {
  source: AgentSource;
  assetCache: AssetCache;
  staticDir: string;
  port: number;
}

export interface OfficeServerHandle {
  url: string;
  stop: () => Promise<void>;
}


export async function startOfficeServer(options: OfficeServerOptions): Promise<OfficeServerHandle> {
  ensureDataDir();
  const { source, assetCache } = options;
  const token = crypto.randomBytes(32).toString('hex');
  const roomRegistry = new RoomRegistry();

  let settings: Settings = { ...DEFAULT_SETTINGS, ...readJson<Partial<Settings>>('settings.json', {}) };
  settings.companyName = cleanCompanyName(settings.companyName);
  if (!LANGUAGES.has(settings.language)) settings.language = 'sk';
  let seats = readJson<Record<string, SeatMeta>>('seats.json', {});
  const agentIds = readJson<Record<string, number>>('agent-ids.json', {});
  let nextId = Math.max(0, ...Object.values(agentIds)) + 1;

  const agents = new Map<string, OfficeAgent>(); // by source key
  const areaMappings: Record<string, string[]> = {};
  let layout: Record<string, unknown> | null = null;
  const clients = new Set<Send>();
  let sourceError: string | null = null;

  const broadcast = (message: Message) => {
    for (const send of clients) send(message);
  };

  const rebuildLayout = () => {
    layout = assetCache.defaultLayout ? generateRoomsLayout(assetCache.defaultLayout, roomRegistry.rooms) : null;
  };
  rebuildLayout();

  const idForKey = (key: string): number => {
    let id = agentIds[key];
    if (id === undefined) {
      id = nextId++;
      agentIds[key] = id;
      writeJson('agent-ids.json', agentIds);
    }
    return id;
  };

  const agentById = (id: unknown): OfficeAgent | undefined => {
    for (const agent of agents.values()) if (agent.id === id) return agent;
    return undefined;
  };

  // ── Status → office messages ──

  /** Messages that bring a client's view of one agent to its current state. */
  const stateMessages = (agent: OfficeAgent, transition: boolean): Message[] => {
    const id = agent.id;
    const msgs: Message[] = [];
    if (agent.status === 'working' || agent.status === 'blocked') {
      msgs.push({
        type: 'agentToolStart',
        id,
        toolId: `${WORK_TOOL_PREFIX}${agent.workToolSeq}`,
        status: agent.status === 'blocked' ? 'hq:waiting' : agent.activity || 'hq:working',
        toolName: 'Hub',
        permissionActive: agent.status === 'blocked',
      });
      msgs.push({ type: 'agentStatus', id, status: 'active' });
      if (agent.status === 'blocked') msgs.push({ type: 'agentToolPermission', id });
    } else {
      msgs.push({ type: 'agentToolPermissionClear', id });
      msgs.push({ type: 'agentToolsClear', id });
      // "done" right after work earns the green check bubble (+ sound); a
      // fresh connect or an idle agent just sits without one.
      msgs.push({ type: 'agentStatus', id, status: transition && agent.status === 'done' ? 'waiting' : 'idle' });
    }
    for (const [slot, kind] of agent.subagents) {
      msgs.push({
        type: 'agentToolStart',
        id,
        toolId: slot,
        status: `Subtask: ${kind}`,
        toolName: 'Agent',
        runInBackground: true,
      });
    }
    return msgs;
  };

  const createMessages = (agent: OfficeAgent): Message[] => {
    const meta = seats[String(agent.id)] ?? {};
    return [
      {
        type: 'agentCreated',
        id: agent.id,
        folderName: agent.project,
        palette: meta.palette,
        hueShift: meta.hueShift,
      },
      { type: 'agentTitle', id: agent.id, title: agent.title },
    ];
  };

  /** Give the project a room; a brand-new room means a bigger office for everyone. */
  const ensureRoom = (project: string) => {
    if (areaMappings[project]) return;
    const { label, added } = roomRegistry.roomFor(project);
    areaMappings[project] = [label];
    if (added) {
      rebuildLayout();
      broadcast({ type: 'layoutLoaded', layout });
    }
    broadcast({ type: 'areaMappingsLoaded', mappings: areaMappings });
  };

  // ── Poll the sources ──

  const poll = async (): Promise<void> => {
    let list: AgentSnapshot[];
    try {
      list = await source.poll();
      if (sourceError) console.log('[agents-hq] agent source is reachable again');
      sourceError = null;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (sourceError !== message) console.error(`[agents-hq] agent source not reachable: ${message}`);
      sourceError = message;
      return;
    }

    const seen = new Set<string>();
    for (const snap of list) {
      seen.add(snap.key);
      ensureRoom(snap.project);

      let agent = agents.get(snap.key);
      if (!agent) {
        agent = {
          id: idForKey(snap.key),
          key: snap.key,
          project: snap.project,
          kind: snap.kind,
          canFocus: snap.canFocus,
          title: snap.title,
          status: snap.status,
          activity: snap.activity,
          workToolSeq: 1,
          subagents: new Map(),
          idleSince: isIdleStatus(snap.status) ? Date.now() : null,
          napping: false,
          workSince: isIdleStatus(snap.status) ? null : Date.now(),
          usedSubagents: snap.subagents.length > 0,
        };
        snap.subagents.forEach((kind, i) => agent!.subagents.set(`${SUB_TOOL_PREFIX}${i}`, kind));
        agents.set(snap.key, agent);
        for (const m of [...createMessages(agent), ...stateMessages(agent, false)]) broadcast(m);
        broadcast({ type: 'agentRawStatus', id: agent.id, status: agent.status });
        continue;
      }

      if (agent.title !== snap.title) {
        agent.title = snap.title;
        broadcast({ type: 'agentTitle', id: agent.id, title: snap.title });
      }

      const statusChanged = agent.status !== snap.status;
      const activityChanged = agent.activity !== snap.activity;
      if (statusChanged || (activityChanged && snap.status === 'working')) {
        if (agent.status === 'working' || agent.status === 'blocked') {
          broadcast({ type: 'agentToolDone', id: agent.id, toolId: `${WORK_TOOL_PREFIX}${agent.workToolSeq}` });
        }
        agent.workToolSeq++;
        const wasWorking = !isIdleStatus(agent.status);
        if (!isIdleStatus(snap.status)) {
          agent.idleSince = null;
          if (agent.workSince === null) {
            agent.workSince = Date.now();
            agent.usedSubagents = false;
          }
        } else {
          if (agent.idleSince === null) agent.idleSince = Date.now();
          // Finished a stretch of work: gym if it used subagents, shower if it was long.
          if (wasWorking && agent.workSince !== null) {
            const perk = agent.usedSubagents
              ? 'gym'
              : Date.now() - agent.workSince >= SHOWER_AFTER_MS
                ? 'shower'
                : null;
            if (perk) broadcast({ type: 'agentPerk', id: agent.id, perk });
            agent.workSince = null;
          }
        }
        if (statusChanged) broadcast({ type: 'agentRawStatus', id: agent.id, status: snap.status });
        agent.status = snap.status;
        agent.activity = snap.activity;
        // Re-send state, but subagents are reconciled separately below.
        const subs = agent.subagents;
        agent.subagents = new Map();
        for (const m of stateMessages(agent, statusChanged)) broadcast(m);
        agent.subagents = subs;
      }

      if (snap.subagents.length > 0) agent.usedSubagents = true;

      // Reconcile subagent characters by slot.
      const wanted = new Map<string, string>();
      snap.subagents.forEach((kind, i) => wanted.set(`${SUB_TOOL_PREFIX}${i}`, kind));
      for (const slot of agent.subagents.keys()) {
        if (!wanted.has(slot)) broadcast({ type: 'subagentClear', id: agent.id, parentToolId: slot });
      }
      for (const [slot, kind] of wanted) {
        if (!agent.subagents.has(slot)) {
          broadcast({
            type: 'agentToolStart',
            id: agent.id,
            toolId: slot,
            status: `Subtask: ${kind}`,
            toolName: 'Agent',
            runInBackground: true,
          });
        }
      }
      agent.subagents = wanted;
    }

    const now = Date.now();
    for (const agent of agents.values()) {
      const napping = agent.idleSince !== null && now - agent.idleSince >= NAP_AFTER_MS;
      if (napping !== agent.napping) {
        agent.napping = napping;
        broadcast({ type: 'agentNap', id: agent.id, napping });
      }
    }

    for (const [key, agent] of agents) {
      if (!seen.has(key)) {
        agents.delete(key);
        broadcast({ type: 'agentClosed', id: agent.id });
      }
    }
  };

  // ── Client handshake ──

  const hqSettings = (): Message => ({
    type: 'hqSettings',
    companyName: settings.companyName,
    language: settings.language,
  });

  const handshake = (send: Send): void => {
    send({ type: 'providerCapabilities', readingTools: [], subagentToolNames: ['Agent', 'Task'] });
    if (assetCache.floorTiles) send({ type: 'floorTilesLoaded', sprites: assetCache.floorTiles });
    if (assetCache.wallTiles) send({ type: 'wallTilesLoaded', sets: assetCache.wallTiles });
    if (assetCache.carpetTiles) send({ type: 'carpetTilesLoaded', sets: assetCache.carpetTiles });
    if (assetCache.furniture) {
      send({
        type: 'furnitureAssetsLoaded',
        catalog: assetCache.furniture.catalog,
        sprites: Object.fromEntries(assetCache.furniture.sprites),
      });
    }
    send({
      type: 'settingsLoaded',
      soundEnabled: settings.soundEnabled,
      lastSeenVersion: settings.lastSeenVersion,
      extensionVersion: process.env.PIXEL_AGENTS_VERSION ?? '',
      watchAllSessions: false,
      alwaysShowLabels: settings.alwaysShowLabels,
      ghostHeadlessAgents: false,
      hooksEnabled: false,
      hooksInfoShown: true,
      externalAssetDirectories: [],
      showAreas: settings.showAreas,
    });
    send(hqSettings());
    send({ type: 'areaMappingsLoaded', mappings: areaMappings });

    const ids: number[] = [];
    const folderNames: Record<number, string> = {};
    const agentMeta: Record<number, SeatMeta> = {};
    for (const agent of agents.values()) {
      ids.push(agent.id);
      folderNames[agent.id] = agent.project;
      agentMeta[agent.id] = seats[String(agent.id)] ?? {};
    }
    send({ type: 'existingAgents', agents: ids, agentMeta, folderNames, externalAgents: {} });
    send({ type: 'layoutLoaded', layout });

    for (const agent of agents.values()) {
      send({ type: 'agentTitle', id: agent.id, title: agent.title });
      for (const m of stateMessages(agent, false)) send(m);
      send({ type: 'agentRawStatus', id: agent.id, status: agent.status });
      if (agent.napping) send({ type: 'agentNap', id: agent.id, napping: true });
    }
  };

  // ── Client messages (allowlist) ──

  const handleMessage = async (msg: Message, send: Send, busy: { read: boolean }): Promise<void> => {
    switch (msg.type) {
      case 'webviewReady':
        handshake(send);
        return;

      case 'hubReadAgent': {
        const agent = agentById(msg.id);
        if (!agent || busy.read) return;
        busy.read = true;
        const detail = {
          type: 'hubAgentDetail',
          id: agent.id,
          workspace: agent.project,
          title: agent.title,
          status: agent.status,
          kind: agent.kind,
          canFocus: agent.canFocus,
        };
        try {
          const text = await source.read(agent.key);
          send({ ...detail, text: stripTrailingBlankLines(text) });
        } catch (err) {
          send({ ...detail, text: '', error: err instanceof Error ? err.message : String(err) });
        } finally {
          busy.read = false;
        }
        return;
      }

      case 'hubListAgents': {
        // Read-only overview for the agent list (status, project, whether the terminal can be focused).
        send({
          type: 'hubAgentList',
          agents: [...agents.values()].map((a) => ({
            id: a.id,
            project: a.project,
            title: a.title,
            status: a.status,
            kind: a.kind,
            activity: a.activity,
            napping: a.napping,
            canFocus: a.canFocus,
          })),
        });
        return;
      }

      case 'hubFocusAgent': {
        const agent = agentById(msg.id);
        if (!agent || !agent.canFocus || !source.focus) return;
        try {
          await source.focus(agent.key);
          send({ type: 'hubFocusResult', id: agent.id, ok: true });
        } catch (err) {
          console.error(`[agents-hq] focus failed: ${err instanceof Error ? err.message : err}`);
          send({ type: 'hubFocusResult', id: agent.id, ok: false });
        }
        return;
      }

      case 'saveAgentSeats':
        if (isPlainObject(msg.seats)) {
          const clean: Record<string, SeatMeta> = {};
          for (const [key, raw] of Object.entries(msg.seats as Record<string, unknown>)) {
            if (!/^\d+$/.test(key) || !isPlainObject(raw)) continue;
            const meta = raw as Record<string, unknown>;
            clean[key] = {
              palette: Number.isInteger(meta.palette) ? (meta.palette as number) : undefined,
              hueShift: Number.isInteger(meta.hueShift) ? (meta.hueShift as number) : undefined,
              seatId: typeof meta.seatId === 'string' ? meta.seatId.slice(0, 200) : undefined,
            };
          }
          seats = { ...seats, ...clean };
          writeJson('seats.json', seats);
        }
        return;

      case 'setSoundEnabled':
      case 'setAlwaysShowLabels':
      case 'setShowAreas': {
        if (typeof msg.enabled !== 'boolean') return;
        const key =
          msg.type === 'setSoundEnabled'
            ? 'soundEnabled'
            : msg.type === 'setAlwaysShowLabels'
              ? 'alwaysShowLabels'
              : 'showAreas';
        settings = { ...settings, [key]: msg.enabled };
        writeJson('settings.json', settings);
        return;
      }

      case 'setLastSeenVersion':
        if (typeof msg.version === 'string') {
          settings = { ...settings, lastSeenVersion: msg.version.slice(0, 40) };
          writeJson('settings.json', settings);
        }
        return;

      case 'setCompanyName':
        if (typeof msg.name !== 'string') return;
        settings = { ...settings, companyName: cleanCompanyName(msg.name) };
        writeJson('settings.json', settings);
        broadcast(hqSettings());
        return;

      case 'setLanguage':
        if (typeof msg.language !== 'string' || !LANGUAGES.has(msg.language)) return;
        settings = { ...settings, language: msg.language as Settings['language'] };
        writeJson('settings.json', settings);
        broadcast(hqSettings());
        return;

      default:
        // Everything else (layout edits, closing agents, hooks, external
        // asset dirs…) is deliberately ignored.
        return;
    }
  };

  // ── HTTP + WebSocket ──

  const app = Fastify({ logger: false });
  await app.register(fastifyWebsocket, { options: { maxPayload: MAX_WS_PAYLOAD_BYTES } });
  await app.register(fastifyStatic, { root: options.staticDir, prefix: '/' });
  // The page may talk only to this server: the browser itself blocks any
  // request to another host, so nothing can leave the machine from the UI.
  const csp = [
    "default-src 'self'",
    `connect-src 'self' ws://127.0.0.1:${options.port} ws://localhost:${options.port}`,
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "media-src 'self' data: blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('Content-Security-Policy', csp);
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'no-referrer');
    return payload;
  });
  app.setNotFoundHandler((_req, reply) => {
    reply.sendFile('index.html');
  });

  const allowedHosts = new Set([`127.0.0.1:${options.port}`, `localhost:${options.port}`]);

  app.get('/ws', { websocket: true }, (socket, request) => {
    const host = request.headers.host ?? '';
    const origin = request.headers.origin;
    const originOk =
      origin === undefined || [...allowedHosts].some((h) => origin === `http://${h}`);
    if (!allowedHosts.has(host) || !originOk || !tokenMatches(request.url, token)) {
      socket.close(4401, 'unauthorized');
      return;
    }

    const send: Send = (message) => {
      if (socket.readyState === 1) socket.send(JSON.stringify(message));
    };
    const busy = { read: false };
    clients.add(send);
    socket.on('message', (data: Buffer | string) => {
      let msg: Message;
      try {
        msg = JSON.parse(data.toString()) as Message;
      } catch {
        return;
      }
      if (!isPlainObject(msg) || typeof msg.type !== 'string') return;
      void handleMessage(msg, send, busy).catch((err) => {
        console.error('[agents-hq] message handling failed:', err);
      });
    });
    socket.on('close', () => clients.delete(send));
  });

  try {
    await app.listen({ host: '127.0.0.1', port: options.port });
  } catch (err) {
    await app.close().catch(() => {});
    throw err;
  }

  // First poll before anyone connects, then keep polling.
  await poll().catch(() => {});
  let polling = false;
  const timer = setInterval(() => {
    if (polling) return;
    polling = true;
    poll()
      .catch((err) => console.error('[agents-hq] poll failed:', err))
      .finally(() => {
        polling = false;
      });
  }, POLL_INTERVAL_MS);

  const url = `http://127.0.0.1:${options.port}/?token=${token}`;
  writeUrlFile(url);

  return {
    url,
    stop: async () => {
      clearInterval(timer);
      // Another office (e.g. a --demo run) may have saved its URL since; leave that one.
      try {
        const file = path.join(DATA_DIR, 'url');
        if (fs.readFileSync(file, 'utf-8').trim() === url) fs.unlinkSync(file);
      } catch {
        // already gone
      }
      await app.close();
    },
  };
}

// ── Helpers ────────────────────────────────────────────────────

function tokenMatches(url: string | undefined, expected: string): boolean {
  let provided = '';
  try {
    provided = new URL(url ?? '', 'http://localhost').searchParams.get('token') ?? '';
  } catch {
    return false;
  }
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stripTrailingBlankLines(text: string): string {
  return text.replace(/\s+$/u, '');
}

/** Plain text only, one line, short. */
function cleanCompanyName(name: unknown): string {
  if (typeof name !== 'string') return '';
  return name
    .replace(/[\u0000-\u001f\u007f<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, COMPANY_NAME_MAX);
}

/** The tokened URL, so a second `agents-hq` run can just reopen it. Readable only by you. */
function writeUrlFile(url: string): void {
  fs.writeFileSync(path.join(DATA_DIR, 'url'), `${url}\n`, { mode: 0o600 });
}
