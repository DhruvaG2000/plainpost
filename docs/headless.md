# Headless ARM64 Linux

Plainpost runs its HTTP server on the board and its interface in your laptop's browser. The board needs Node.js and the project's npm dependencies, with no desktop, display, browser, database service, or native compilation. Gmail needs outbound TLS connections to IMAP port 993 and SMTP port 465 (or 587); lore needs HTTPS. Plainpost binds only to `127.0.0.1`; use SSH forwarding to reach it from another computer.

## BeaglePlay example

1. Flash a current **64-bit Debian image for BeaglePlay** to microSD and boot the board. Follow the [BeagleBoard getting-started guide](https://docs.beagleboard.org/intro/support/getting-started.html) for the image and first boot.
2. Connect Ethernet to your router. Find the board's address in the router's DHCP leases, then connect from your laptop. The example uses the image's `debian` account and an example LAN address. Substitute the address and login for your board.

   ```sh
   ssh debian@192.168.1.50
   ```

3. On the board, install the base tools and a Linux ARM64 Node.js release. Use a distribution package if it provides Node 22 or newer, or use the [official Linux ARM64 build](https://nodejs.org/en/download) and put its `bin` directory on your PATH.

   ```sh
   sudo apt update
   sudo apt install ca-certificates curl git
   uname -m
   node -p 'process.platform + " " + process.arch + " " + process.version'
   npm --version
   git clone https://github.com/DhruvaG2000/plainpost.git ~/plainpost
   cd ~/plainpost
   sh scripts/setup-linux.sh
   ```

   Expect `aarch64` from the kernel and `linux arm64` with Node 22 or newer. If the repository requires GitHub authentication, use an authorized Git login or copy an authorized checkout to the board. The setup script installs lockfile dependencies with lifecycle scripts disabled. It leaves Gmail configuration and service setup to the commands below.

These steps also apply to another ARM64 Debian-based board with a supported OS image, such as Raspberry Pi OS Lite (64-bit). Gmail API authorization and lore access use outbound HTTPS (443). SSH access requires the board's SSH port, normally 22.

## Start and open the interface

On the board:

```sh
cd ~/plainpost
sh scripts/start-linux.sh
```

The launcher stores the encrypted vault under `${XDG_DATA_HOME:-$HOME/.local/share}/plainpost`, with private Linux permissions. Set `DATA_DIR` in the shell before launching to choose another persistent directory. Set `NODE_BIN` if your Node executable is outside the shell's PATH. Press `Ctrl+C` to stop this foreground server.

On your laptop, in PowerShell, Linux, macOS, or WSL, substitute the board's SSH login and address:

```sh
ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:4819:127.0.0.1:4819 debian@192.168.1.50
```

Keep that terminal open and visit **http://localhost:4819** in the laptop's browser. Try **Explore demo** or paste a lore thread link. If you run the tunnel inside WSL, open the same URL in your Windows browser using WSL localhost forwarding. Closing the tunnel disconnects the browser from the board; it does not stop the board's server.

Port 4819 on your laptop must be free. Alternatively choose another port, such as 4820, consistently on both ends of the tunnel and in the board's `PORT` and `APP_URL`. Only optional OAuth requires updating a Google callback. The app validates origins, so use the exact configured hostname and port in your browser.

## Gmail login from either browser

| Where the browser runs | Open | How the OAuth callback reaches Plainpost |
| --- | --- | --- |
| On the BeaglePlay with a desktop | `http://localhost:4819` | The browser connects directly to the board's loopback. |
| On your laptop with the SSH tunnel running | `http://localhost:4819` | The browser connects to the laptop's forwarded port, which SSH carries to the board. |

**App password (IMAP/SMTP).** Use your Google Account in either browser to enable 2-Step Verification and create an app password, if your account allows it. On the board, run these commands as the user running Plainpost:

```sh
cd ~/plainpost
npm run config:init
nano ~/.config/plainpost/mail.conf
```

If you set `XDG_CONFIG_HOME` or `PLAINPOST_MAIL_CONFIG`, edit the path reported by the initializer. Set `imap_user` and `imap_pass`, keep mode 600, then choose **settings → Reload config & connect** in the browser. The app tests both mail logins without sending a message. See [Gmail IMAP setup](gmail-imap.md) for static Mutt configs and separate password files.

**Google OAuth (Gmail API).** Follow the [Google OAuth setup](../README.md#optional-google-oauth) and store the client ID and secret in `~/plainpost/.env` on the board. Register `http://localhost:4819/auth/callback` as the Web application client's redirect URI and set `APP_URL=http://localhost:4819`. Restart Plainpost and initiate sign-in from the browser you plan to use. For laptop sign-in, leave the tunnel running from the initial click through Google's redirect and consent. Plainpost ties the authorization request to that browser session. The board exchanges the code over HTTPS and stores its tokens in the board's vault.

If port 4819 is occupied on the laptop, choose a free port such as 4820 on both ends. Set `PORT=4820` and `APP_URL=http://localhost:4820` on the board, then restart Plainpost. Forward the new port with `-L 127.0.0.1:4820:127.0.0.1:4820` and open `http://localhost:4820`. For OAuth, register `http://localhost:4820/auth/callback` before signing in. The server requires the port in `APP_URL` to match `PORT`.

## Start automatically with systemd

Run these commands **on the board**, as the user who will own Plainpost, from the final source directory. First stop the foreground server to free its port. The generator captures the current Node executable and source/data paths, so the service works with Node installed through NVM without loading shell startup files.

```sh
cd ~/plainpost
mkdir -p ~/.config/systemd/user
node scripts/systemd.mjs > ~/.config/systemd/user/plainpost.service
systemd-analyze --user verify ~/.config/systemd/user/plainpost.service
systemctl --user daemon-reload
systemctl --user enable --now plainpost.service
sudo loginctl enable-linger "$USER"
```

Lingering starts your user manager at boot and keeps it running after SSH logout. The service restarts when its process exits and applies `UMask=0077`; an explicit `systemctl --user stop plainpost.service` keeps it stopped. It uses the same data location as the Linux launcher; export a custom `DATA_DIR` **before generating** the unit if needed. The generated setting takes precedence over `DATA_DIR` in `.env`. Gmail IMAP settings come from this service user's home; port settings and optional OAuth credentials come from the project `.env`. Home mail settings reload on connection and mailbox requests.

Check status and logs, or restart after changing `.env`:

```sh
systemctl --user status plainpost.service
journalctl --user -u plainpost.service -n 50 --no-pager
systemctl --user restart plainpost.service
curl http://localhost:4819/api/status
```

If you move the source or upgrade/remove the captured Node version, regenerate the unit, run `daemon-reload`, and restart. Regeneration overwrites the unit, so preserve any manual customizations. Keep the vault's `key` and `vault.json` together when backing up; deleting the data directory requires signing in again.

To stop automatic startup:

```sh
systemctl --user disable --now plainpost.service
```

Keep lingering enabled if other user services depend on it. On systems without systemd, use the foreground launcher under your existing service supervisor. There is no requirement for a graphical session.

## Validation

Run these on the board before connecting Gmail:

```sh
node --test
node scripts/smoke.mjs --linux-launcher
```

The smoke test starts an isolated server on a temporary port, checks the HTTP interface, sends SIGTERM, and removes its temporary vault. It does not send mail or need Gmail credentials. GitHub Actions includes native `ubuntu-24.04-arm` jobs for Node 22 and 24, alongside x64 Linux and Windows. CI runs when the repository is pushed to GitHub; see [runner availability](https://docs.github.com/en/actions/reference/runners/github-hosted-runners).

Local checks cover Windows and native Ubuntu WSL. No physical Raspberry Pi or BeaglePlay was available for testing, and this workstation's Docker daemon lacks ARM64 emulation. Board boot, SSH login, and real Gmail authentication/delivery therefore still need verification on your device. If Gmail/lore requests fail on a freshly provisioned board, check its network, clock, and CA certificates.
