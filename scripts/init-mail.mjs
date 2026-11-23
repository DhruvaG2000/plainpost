import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const path = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'plainpost/mail.conf');
await mkdir(dirname(path), { recursive: true, mode: 0o700 });
process.umask(0o077);
try {
  await writeFile(path, await readFile(fileURLToPath(new URL('../mail.conf.example', import.meta.url))), { flag: 'wx', mode: 0o600 });
  console.log(`Created ${path}. Edit imap_user and imap_pass, then use Connect Gmail in Plainpost. Do not paste your app password into chat.`);
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
  console.log(`${path} already exists; left it unchanged.`);
}
