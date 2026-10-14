// Agents HQ build: bundles the local server into dist/agents-hq.js and copies
// the office assets. The browser UI is built separately by Vite (webview-ui).

const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const production = process.argv.includes('--production');
const pkgVersion = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf-8')).version;

function copyAssets() {
  const srcDir = path.join(__dirname, 'webview-ui', 'public', 'assets');
  const dstDir = path.join(__dirname, 'dist', 'assets');
  fs.rmSync(dstDir, { recursive: true, force: true });
  fs.cpSync(srcDir, dstDir, { recursive: true });
}

async function main() {
  await esbuild.build({
    entryPoints: ['server/src/hub/main.ts'],
    bundle: true,
    format: 'cjs',
    minify: production,
    sourcemap: false,
    platform: 'node',
    target: 'node20',
    outfile: 'dist/agents-hq.js',
    external: ['fastify', '@fastify/websocket', '@fastify/static'],
    define: { 'process.env.PIXEL_AGENTS_VERSION': JSON.stringify(pkgVersion) },
    logLevel: 'warning',
    metafile: true,
  }).then((result) => {
    fs.writeFileSync(path.join(__dirname, 'dist', 'meta.json'), JSON.stringify(result.metafile));
  });
  fs.chmodSync(path.join(__dirname, 'dist', 'agents-hq.js'), 0o755);
  copyAssets();
  console.log('✓ dist/agents-hq.js + dist/assets');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
