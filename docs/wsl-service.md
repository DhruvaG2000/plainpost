# Keep Plainpost running in WSL

From the Plainpost checkout in WSL, install the dependencies and start the tmux launcher. Install tmux through your Linux package manager if needed. Stop any foreground Plainpost instance first so the port is available.

```sh
sh scripts/setup-linux.sh
sh scripts/tmux-wsl.sh start
tmux attach-session -t 0
```

The launcher starts a window named `plainpost` in session `0`. Detach with `Ctrl+B`, then `D`. Press `Ctrl+C` in the Plainpost window to stop it. Unexpected exits restart after five seconds.

Open **http://localhost:4819** in your Windows browser. The Linux vault defaults to `${XDG_DATA_HOME:-$HOME/.local/share}/plainpost`. Configure [Gmail IMAP](gmail-imap.md) or [OAuth](../README.md#optional-google-oauth) in the WSL environment running the server.

## Start at Windows logon

In Windows Task Scheduler, create a task triggered at your Windows logon. Set the action's program to `wsl.exe` and use arguments like these, replacing `Ubuntu` and the path with your distribution and checkout. Find your distribution name with `wsl -l -q`.

```text
-d Ubuntu -- /bin/sh /home/your-user/plainpost/scripts/tmux-wsl.sh keepalive
```

Configure the task to allow it to run indefinitely and skip a new instance if one is already running. The `keepalive` action keeps the WSL instance alive after other terminals close. It requires Linux Node.js and tmux on the PATH provided by the scheduled invocation. If Node is installed via a shell version manager, use a wrapper that loads that manager before invoking the script.

Run the task once from Task Scheduler and verify it from PowerShell.

```powershell
Invoke-RestMethod http://localhost:4819/api/status
```

Use Task Scheduler to disable future launches and stop the keepalive action. Stop the Plainpost process in its tmux window as well. Windows shutdown or terminating WSL interrupts serving.
