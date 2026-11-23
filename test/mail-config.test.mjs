import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadMailConfig, publicMailConfig, configValue } from '../server/mail-config.mjs';

async function homeFixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'plainpost-config-'));
  await mkdir(join(home, '.config/plainpost'), { recursive: true });
  t.after(() => rm(home, { recursive: true }));
  const path = join(home, '.config/plainpost/mail.conf');
  const write = text => writeFile(path, text, { mode: 0o600 });
  return { home, path, write, load: () => loadMailConfig({ home, env: {} }) };
}
const base = 'set imap_user = "kernel@gmail.com"\nset folder = "imaps://imap.gmail.com/"\nset imap_pass = "abcd efgh ijkl mnop"\nset smtp_url = "smtp://kernel%40gmail.com@smtp.gmail.com:587/"\nset smtp_pass = $imap_pass # same secret\nset from = "Kernel Hacker <kernel@gmail.com>"\n';

test('home config uses Mutt variables, TLS and app passwords without exposing secrets', async t => {
  const f = await homeFixture(t);
  assert.equal((await f.load()).configured, false);
  await f.write(base);
  const config = await f.load();
  assert.equal(config.configured, true, config.error);
  assert.equal(config.email, 'kernel@gmail.com');
  assert.equal(config.imap.auth.pass, 'abcdefghijklmnop');
  assert.equal(config.smtp.port, 587); assert.equal(config.smtp.requireTLS, true);
  assert.equal(config.smtp.auth.pass, config.imap.auth.pass);
  assert.doesNotMatch(JSON.stringify(publicMailConfig(config)), /abcd|imap_pass|auth/);
  await f.write(base.replace('imap.gmail.com', 'evil.example.org'));
  assert.equal((await f.load()).configured, false);
  assert.equal(configValue('value # comment', {}, f.home), 'value');
  await f.write(base.replace('set from = "Kernel Hacker <kernel@gmail.com>"', 'set from = $imap_user\nset realname = "Kernel Hacker"'));
  assert.equal((await f.load()).from, '"Kernel Hacker" <kernel@gmail.com>');
});

test('static muttrc source and private password file work; executable sources are rejected', async t => {
  const f = await homeFixture(t);
  const password = join(f.home, 'password');
  await writeFile(password, 'abcdefghijklmnop\n', { mode: 0o600 });
  const muttrc = join(f.home, '.muttrc');
  await writeFile(muttrc, base.replace('set imap_pass = "abcd efgh ijkl mnop"', 'set imap_pass_file = "~/password"').replace('set smtp_pass = $imap_pass # same secret', ''), { mode: 0o600 });
  assert.equal((await f.load()).configured, true);
  await f.write('source "~/.muttrc"\n');
  assert.equal((await f.load()).configured, true);
  await f.write('source "gpg --decrypt secret|"\n');
  assert.match((await f.load()).error, /pipes/);
  await f.write(base.replace('abcd efgh ijkl mnop', '`cat secret`'));
  assert.match((await f.load()).error, /Shell commands/);
  await f.write('source "~/.config/plainpost/mail.conf"\n');
  assert.match((await f.load()).error, /cycle/);
});

test('unsafe permissions and regular Google passwords fail with actionable instructions', async t => {
  const f = await homeFixture(t);
  await f.write(base.replace('abcd efgh ijkl mnop', 'normal-password'));
  assert.match((await f.load()).error, /app password/);
  if (process.platform !== 'win32') {
    await f.write(base); await chmod(f.path, 0o644);
    assert.match((await f.load()).error, /chmod 600/);
  }
});
