#!/bin/sh
# Start Plainpost in a dedicated window of tmux session 0.
set -eu
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
project_dir=$(dirname -- "$script_dir")

case "${1:-start}" in
  serve)
    cd "$project_dir"
    umask 077
    export DATA_DIR="${DATA_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/plainpost}"
    node_binary=$(command -v node)
    trap 'exit 0' INT TERM
    printf 'Plainpost: http://localhost:4819\nCtrl+C stops this window; detaching tmux leaves it serving.\n'
    while :; do
      "$node_binary" server/index.mjs &
      server_pid=$!
      trap 'kill "$server_pid" 2>/dev/null || :; wait "$server_pid" 2>/dev/null || :; exit 0' INT TERM
      status=0
      wait "$server_pid" || status=$?
      trap 'exit 0' INT TERM
      printf 'Server exited (%s); restarting in 5 seconds. Ctrl+C to stop.\n' "$status"
      sleep 5
    done
    ;;
  start|keepalive)
    command -v tmux >/dev/null
    command -v node >/dev/null
    if ! tmux has-session -t '=0' 2>/dev/null; then
      tmux new-session -d -s 0 -n shell
    fi
    found=false
    for window in $(tmux list-windows -t '=0' -F '#{window_name}'); do
      if [ "$window" = plainpost ]; then found=true; fi
    done
    if [ "$found" = false ]; then
      tmux new-window -d -P -F '#{window_id}' -t '0:' -n plainpost -c "$project_dir" /bin/sh "$script_dir/tmux-wsl.sh" serve
    fi
    if [ "${1:-start}" = keepalive ]; then exec /usr/bin/sleep infinity; fi
    ;;
  *) printf 'Usage: %s [start|keepalive]\n' "$0" >&2; exit 2 ;;
esac
