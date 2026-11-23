// Run in Linux/WSL or Windows: start the real entry point and check HTTP locally.
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir, platform, arch } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const linuxLauncher = process.argv.includes('--linux-launcher');
if (linuxLauncher && platform() !== 'linux') throw new Error('--linux-launcher requires Linux.');
const probe = createServer().listen(0, '127.0.0.1'); await once(probe, 'listening');
const port = probe.address().port; await new Promise(r => probe.close(r));
const dir = await mkdtemp(join(tmpdir(), 'plainpost-smoke-'));
const appUrl = `http://localhost:${port}`;
const child = spawn(linuxLauncher ? 'sh' : process.execPath, linuxLauncher ? ['scripts/start-linux.sh'] : ['server/index.mjs'], { cwd: root, env: { ...process.env, NODE_BIN: process.execPath, PORT: String(port), APP_URL: appUrl, DATA_DIR: dir, GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
const finished = once(child, 'exit'); let output = '';
child.stdout.on('data', c => { output += c; }); child.stderr.on('data', c => { output += c; });
try {
  let status;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error(output);
    try { const response = await fetch(`${appUrl}/api/status`, { signal: AbortSignal.timeout(1000) }); if (response.ok) { status = await response.json(); break; } } catch { /* startup */ }
    await new Promise(r => setTimeout(r, 100));
  }
  if (!status || status.appUrl !== appUrl) throw new Error('Local server did not become ready. ' + output);
  const page = await (await fetch(appUrl)).text();
  if (!page.includes('lore-form') || !(await fetch(`${appUrl}/threading.js`)).ok) throw new Error('Frontend assets missing.');
  console.log(`${linuxLauncher ? 'Linux launcher' : 'Standalone server'} smoke test passed on ${platform()} ${arch()} ${process.version}: ${appUrl}`);
} finally {
  child.kill('SIGTERM'); await finished;
  if (!resolve(dir).startsWith(resolve(tmpdir()) + sep) || !dir.includes('plainpost-smoke-')) throw new Error('Unsafe cleanup path.');
  await rm(dir, { recursive: true });
}
