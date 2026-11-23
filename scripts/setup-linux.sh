#!/bin/sh
set -eu

cd "$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  printf '%s\n' 'Install Linux Node.js 22 or newer with npm and put both on PATH.' >&2
  exit 1
fi

node --input-type=module -e '
  if (process.platform !== "linux" || Number(process.versions.node.split(".")[0]) < 22) {
    console.error("Plainpost setup requires Linux Node.js 22 or newer.");
    process.exit(1);
  }
'

npm ci --ignore-scripts
printf '%s\n' 'Start Plainpost with sh scripts/start-linux.sh.'
