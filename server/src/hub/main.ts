#!/usr/bin/env node

/**
 * Agents HQ entry point: `agents-hq [--port N] [--no-open]`
 *
 * Starts the local office server on 127.0.0.1, prints the tokened URL (also
 * saved to ~/.agents-hq/url) and opens it in the browser. Ctrl+C stops it.
 */

import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { buildAssetCache } from './assets.js';
import { DATA_DIR, startOfficeServer } from './officeServer.js';
import { createSource } from './sources/index.js';

const DEFAULT_PORT = 3200;

const HELP = `
  Agents HQ by Bonus Round — your AI agents at work in a 3D office.

  Usage: agents-hq [--port <number>] [--no-open] [--demo]

    --port <n>   port on 127.0.0.1 (default: first free from ${DEFAULT_PORT})
    --no-open    do not open the browser
    --demo       made-up agents, to try the office or film it

  Read-only: it only reads which Claude Code / Codex sessions run on this
  computer. Nothing is written outside ~/.agents-hq, nothing leaves the machine.
`;

/** Without --port, this many ports from DEFAULT_PORT up are tried until one is free. */
const PORT_ATTEMPTS = 10;

function parsePort(argv: string[]): number | null {
  const index = argv.findIndex((a) => a === '--port' || a === '-p');
  if (index === -1) return null;
  const port = Number(argv[index + 1]);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    console.error('[agents-hq] --port must be an integer between 1024 and 65535');
    process.exit(1);
  }
  return port;
}

/** Open a URL in the default browser. The URL is built here, never from outside input. */
function openBrowser(url: string): void {
  const done = () => {};
  if (process.platform === 'darwin') execFile('/usr/bin/open', [url], done);
  else if (process.platform === 'win32') execFile('rundll32', ['url.dll,FileProtocolHandler', url], done);
  else execFile('xdg-open', [url], done);
}

/**
 * The URL of an office that already runs on this computer, or null. The saved
 * URL is only trusted when it answers as Agents HQ: the file can outlive a
 * crashed run, and its port may meanwhile belong to a different app.
 */
async function runningUrl(): Promise<string | null> {
  let url: string;
  try {
    url = fs.readFileSync(path.join(DATA_DIR, 'url'), 'utf-8').trim();
  } catch {
    return null;
  }
  if (!url.startsWith('http://127.0.0.1:')) return null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
    return res.ok && (await res.text()).includes('<title>Agents HQ</title>') ? url : null;
  } catch {
    return null;
  }
}

function portOf(url: string): number {
  return Number(new URL(url).port);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(HELP);
    return;
  }
  const explicitPort = parsePort(argv);
  const demo = argv.includes('--demo');
  const shouldOpen = !argv.includes('--no-open');

  // Running the one-liner again just reopens the office that already runs.
  const existing = demo ? null : await runningUrl();
  if (existing && (explicitPort === null || portOf(existing) === explicitPort)) {
    console.log(`\n  Agents HQ already runs at ${existing}\n`);
    if (shouldOpen) openBrowser(existing);
    return;
  }

  const distRoot = __dirname;
  // The asset loader is chatty; keep the terminal output short.
  const log = console.log;
  console.log = () => {};
  const assetCache = await buildAssetCache(distRoot).finally(() => {
    console.log = log;
  });
  const source = await createSource(demo);

  // Another app may hold the default port; then take the next free one.
  const ports =
    explicitPort !== null
      ? [explicitPort]
      : Array.from({ length: PORT_ATTEMPTS }, (_, i) => DEFAULT_PORT + i);
  let server;
  for (const port of ports) {
    try {
      server = await startOfficeServer({
        source,
        assetCache,
        staticDir: path.join(distRoot, 'webview'),
        port,
      });
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw err;
    }
  }
  if (!server) {
    const tried = ports.length === 1 ? `port ${ports[0]} is` : `ports ${ports[0]}–${ports[ports.length - 1]} are`;
    throw new Error(`${tried} already used by another app. Pick a free one: --port <number>`);
  }

  console.log(`\n  Agents HQ by Bonus Round`);
  console.log(`  ${server.url}`);
  console.log(`  Agents from: ${source.name}`);
  console.log('  The URL contains a secret token, do not share it. Ctrl+C stops the office.\n');
  if (shouldOpen) openBrowser(server.url);

  const running = server;
  const shutdown = () => {
    void running.stop().finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[agents-hq] failed to start:', err instanceof Error ? err.message : err);
  process.exit(1);
});
