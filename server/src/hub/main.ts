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

    --port <n>   port on 127.0.0.1 (default ${DEFAULT_PORT})
    --no-open    do not open the browser
    --demo       made-up agents, to try the office or film it

  Read-only: it only reads which Claude Code / Codex sessions run on this
  computer. Nothing is written outside ~/.agents-hq, nothing leaves the machine.
`;

function parsePort(argv: string[]): number {
  const index = argv.findIndex((a) => a === '--port' || a === '-p');
  if (index === -1) return DEFAULT_PORT;
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

function runningUrl(): string | null {
  try {
    const url = fs.readFileSync(path.join(DATA_DIR, 'url'), 'utf-8').trim();
    return url.startsWith('http://127.0.0.1:') ? url : null;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(HELP);
    return;
  }
  const port = parsePort(argv);
  const shouldOpen = !argv.includes('--no-open');

  const distRoot = __dirname;
  // The asset loader is chatty; keep the terminal output short.
  const log = console.log;
  console.log = () => {};
  const assetCache = await buildAssetCache(distRoot).finally(() => {
    console.log = log;
  });
  const source = await createSource(argv.includes('--demo'));

  let server;
  try {
    server = await startOfficeServer({
      source,
      assetCache,
      staticDir: path.join(distRoot, 'webview'),
      port,
    });
  } catch (err) {
    const existing = runningUrl();
    if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE' && existing) {
      console.log(`\n  Agents HQ already runs at ${existing}\n`);
      if (shouldOpen) openBrowser(existing);
      return;
    }
    throw err;
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
