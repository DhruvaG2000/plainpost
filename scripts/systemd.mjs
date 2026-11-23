// Print a user service; redirect stdout to ~/.config/systemd/user/plainpost.service.
// Capture the running Node executable so boot does not depend on shell/NVM setup.
import { homedir } from 'node:os';
import { posix, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

function pathValue(value) {
  if (!posix.isAbsolute(value) || /[\x00-\x1f\x7f]/.test(value)) throw new Error('Service paths must be absolute Linux paths without control characters.');
  return quoted(value);
}

function quoted(value) {
  // systemd specifiers and quoted string syntax, not shell quoting.
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%')}"`;
}

export function serviceUnit({ root, node, dataDir }) {
  pathValue(root);
  // WorkingDirectory takes a literal path, unlike ExecStart's quoted arguments.
  // A trailing slash preserves a directory name ending in whitespace.
  const workingDirectory = root.replace(/\/?$/, '/').replaceAll('%', '%%');
  const executable = pathValue(node);
  const entrypoint = pathValue(posix.join(root, 'server/index.mjs'));
  pathValue(dataDir);
  const data = quoted(`DATA_DIR=${dataDir}`);
  return `[Unit]
Description=Plainpost plain-text Gmail and lore reader
StartLimitIntervalSec=60
StartLimitBurst=5

[Service]
Type=exec
WorkingDirectory=${workingDirectory}
# The colon disables systemd environment expansion in executable arguments.
ExecStart=:${executable} ${entrypoint}
Environment=${data}
UMask=0077
NoNewPrivileges=true
Restart=always
RestartSec=5
TimeoutStopSec=15

[Install]
WantedBy=default.target
`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.platform !== 'linux' || Number(process.versions.node.split('.')[0]) < 22) throw new Error('Generate this service on the Linux host with Node.js 22 or newer.');
  if (process.argv.length !== 2) throw new Error('Usage: node scripts/systemd.mjs');
  const root = fileURLToPath(new URL('../', import.meta.url)).replace(/\/$/, '');
  const dataDir = resolve(root, process.env.DATA_DIR || posix.join(process.env.XDG_DATA_HOME || posix.join(homedir(), '.local/share'), 'plainpost'));
  process.stdout.write(serviceUnit({ root, node: process.execPath, dataDir }));
}
