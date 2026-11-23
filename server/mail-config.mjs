import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, dirname, resolve } from 'node:path';
import { AppError, addresses } from './mail.mjs';

const keys = new Set(['imap_user', 'imap_pass', 'imap_pass_file', 'smtp_user', 'smtp_pass', 'smtp_pass_file', 'smtp_url', 'folder', 'from', 'realname']);
export const mailConfigCandidates = (home = homedir(), env = process.env) => env.PLAINPOST_MAIL_CONFIG
  ? [expandPath(env.PLAINPOST_MAIL_CONFIG, home)]
  : [join(env.XDG_CONFIG_HOME || join(home, '.config'), 'plainpost/mail.conf'), join(home, '.muttrc'), join(home, '.config/mutt/muttrc'), join(home, '.neomuttrc'), join(home, '.config/neomutt/neomuttrc')];

function expandPath(path, home, base = home) {
  path = path.replace(/^~(?=$|[\\/])/, home).replace(/\$\{?HOME\}?/g, home);
  return isAbsolute(path) ? path : resolve(base, path);
}
async function privateFile(path) {
  const info = await stat(path);
  if (!info.isFile() || info.size > 64 * 1024) throw new AppError('Mail configuration and password files must be regular files under 64 KiB.');
  if (process.platform !== 'win32' && ((info.mode & 0o077) || info.uid !== process.getuid())) throw new AppError('Mail configuration and password files must belong to the server user and have mode 600 (chmod 600).');
  return readFile(path, 'utf8');
}

// Parse a static subset of muttrc. Never execute source pipes, hooks or backticks.
export function configValue(raw, values, home) {
  if (raw.includes('`') || raw.includes('$(') || /[\x00\r\n]/.test(raw)) throw new AppError('Shell commands are not supported in mail settings. Use a private app-password file instead.');
  let value = '', quote = '', escaped = false, ended = false;
  for (const ch of raw.trim()) {
    if (ended) { if (ch === '#') break; if (!/\s/.test(ch)) throw new AppError('Use one static value per mail setting.'); continue; }
    if (escaped) { value += ch; escaped = false; continue; }
    if (ch === '\\' && quote !== "'") { escaped = true; continue; }
    if (quote) { if (ch === quote) { quote = ''; ended = true; } else value += ch; }
    else if ((ch === '"' || ch === "'") && !value) quote = ch;
    else if (ch === '#') break;
    else if (/\s/.test(ch)) ended = true;
    else value += ch;
  }
  if (quote || escaped) throw new AppError('Unclosed quote or escape in mail configuration.');
  return value.replace(/\$(?:\{(\w+)\}|(\w+))/g, (_, a, b) => {
    const name = a || b;
    if (name === 'HOME') return home;
    if (!(name in values)) throw new AppError('Mail setting refers to an undefined variable.');
    return values[name];
  });
}

async function parseFile(path, home, values = {}, seen = new Set()) {
  if (seen.has(path) || seen.size >= 8) throw new AppError('Mail configuration sources contain a cycle or more than eight files.');
  seen.add(path);
  for (const line of (await privateFile(path)).split(/\r?\n/)) {
    if (/^\s*(#|$)/.test(line)) continue;
    const source = line.match(/^\s*source\s+(.+)$/);
    if (source) {
      const target = configValue(source[1], values, home);
      if (target.includes('|')) throw new AppError('Mutt source pipes are not supported. Use a dedicated ~/.config/plainpost/mail.conf.');
      await parseFile(expandPath(target, home, dirname(path)), home, values, seen);
      continue;
    }
    const setting = line.match(/^\s*set\s+(\w+)\s*=\s*(.+)$/);
    if (setting && (keys.has(setting[1]) || setting[1].startsWith('my_'))) values[setting[1]] = configValue(setting[2], values, home);
    // Unrelated Mutt display options are intentionally ignored. Hooks are not run.
  }
  return values;
}

export async function loadMailConfig({ home = homedir(), env = process.env } = {}) {
  const candidates = mailConfigCandidates(home, env);
  let path = candidates[0];
  try {
    let found = false;
    for (const candidate of candidates) {
      try { await stat(candidate); path = candidate; found = true; break; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    if (!found) return { configured: false, path, email: '', error: 'Create a private home-directory mail configuration to connect Gmail over IMAP.' };
    const v = await parseFile(path, home);
    const imap = new URL(v.folder || 'imaps://imap.gmail.com/');
    const smtp = new URL(v.smtp_url || 'smtps://smtp.gmail.com:465/');
    if (imap.protocol !== 'imaps:' || imap.hostname !== 'imap.gmail.com' || (imap.port && imap.port !== '993') || imap.password || smtp.hostname !== 'smtp.gmail.com' || smtp.password || !((smtp.protocol === 'smtps:' && (!smtp.port || smtp.port === '465')) || (smtp.protocol === 'smtp:' && smtp.port === '587'))) throw new AppError('Use imaps://imap.gmail.com:993 and Gmail SMTP with TLS: smtps://smtp.gmail.com:465 or smtp://smtp.gmail.com:587. Put passwords in separate settings, not URLs.');
    const email = v.imap_user || decodeURIComponent(imap.username);
    if (!email || addresses(email).length !== 1 || addresses(email)[0].email !== email || email === 'you@gmail.com') throw new AppError('Replace imap_user with your full Gmail account address.');
    const pass = v.imap_pass_file ? (await privateFile(expandPath(v.imap_pass_file, home, dirname(path)))).trim() : v.imap_pass;
    const smtpPass = v.smtp_pass_file ? (await privateFile(expandPath(v.smtp_pass_file, home, dirname(path)))).trim() : v.smtp_pass || pass;
    if (!pass || !smtpPass || [pass, smtpPass].some(p => !/^[a-z]{16}$/i.test(p.replace(/ /g, '')) || p === 'your-app-password')) throw new AppError('Set the 16-character Google app password in imap_pass (or imap_pass_file). Your regular Google password will not work.');
    const smtpUser = v.smtp_user || decodeURIComponent(smtp.username) || email;
    if (smtpUser !== email) throw new AppError('The SMTP login must match imap_user.');
    let from = v.from || email;
    const sender = addresses(from);
    if (sender.length !== 1) throw new AppError('Set from to a single sender address.');
    if (v.realname && !sender[0].name) {
      if (/[\x00-\x1f\x7f]/.test(v.realname)) throw new AppError('The sender name cannot contain control characters.');
      from = `"${v.realname.replace(/["\\]/g, '\\$&')}" <${sender[0].email}>`;
    }
    return { configured: true, path, email, from, imap: { host: 'imap.gmail.com', port: 993, secure: true, auth: { user: email, pass: pass.replace(/ /g, '') } }, smtp: { host: 'smtp.gmail.com', port: smtp.port ? Number(smtp.port) : 465, secure: smtp.protocol === 'smtps:', requireTLS: true, auth: { user: email, pass: smtpPass.replace(/ /g, '') } } };
  } catch (error) {
    return { configured: false, path, email: '', error: error.status ? error.message : 'Cannot read mail settings. Check the file syntax, paths and private permissions.' };
  }
}

export function publicMailConfig(config) {
  return { configured: config.configured, path: config.path, email: config.email || '', error: config.error || '', transport: 'imap-smtp' };
}
