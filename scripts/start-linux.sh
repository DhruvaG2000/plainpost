#!/bin/sh
set -eu
cd "$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
node_bin="${NODE_BIN:-node}"
if ! command -v "$node_bin" >/dev/null 2>&1; then
  printf '%s\n' 'Install Linux Node.js 22 or newer, or set NODE_BIN to its executable.' >&2
  exit 1
fi
"$node_bin" --input-type=module -e '
  if (process.platform !== "linux" || Number(process.versions.node.split(".")[0]) < 22) {
    console.error("Plainpost requires Linux Node.js 22 or newer for this launcher.");
    process.exit(1);
  }
'
# Keep tokens on the Linux filesystem, including when source lives under /mnt/c.
# An explicit DATA_DIR environment variable takes precedence over .env.
export DATA_DIR="${DATA_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/plainpost}"
umask 077
exec "$node_bin" server/index.mjs
