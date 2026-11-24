import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { gzipSync } from 'node:zlib';
import { Vault } from '../server/vault.mjs';
import { createApp } from '../server/app.mjs';
import { Gmail, GMAIL_SCOPE } from '../server/gmail.mjs';
import { toMbox } from '../server/mail.mjs';
import { loadB4RelayConfig } from '../server/b4-relay.mjs';

async function fixture(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'plainpost-test-'));
  const vault = await new Vault(dir).init();
  const config = { appUrl: '', clientId: '', clientSecret: '', ...options.config };
  const server = await createApp(config, vault, { mailConfigLoader: async () => ({ configured: false, path: '/test/home/mail.conf' }), ...options });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  config.appUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeAllConnections(); await new Promise(r => server.close(r));
    if (!resolve(dir).startsWith(resolve(tmpdir()) + sep) || !dir.includes('plainpost-test-')) throw new Error('Unsafe test cleanup path.');
    await rm(dir, { recursive: true });
  });
  let cookie = '', csrf = '';
  async function request(path, { method = 'GET', body, headers = {}, redirect = 'follow' } = {}) {
    const response = await fetch(config.appUrl + path, { method, redirect, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(method !== 'GET' ? { Origin: config.appUrl, 'X-CSRF-Token': csrf, 'Content-Type': 'application/json' } : {}), ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    if (response.headers.has('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
    return response;
  }
  async function status() { const data = await (await request('/api/status')).json(); csrf = data.csrf; return data; }
  async function demo() { await status(); const response = await request('/api/demo', { method: 'POST', body: {} }); assert.equal(response.status, 200); await status(); }
  return { dir, vault, config, request, status, demo };
}

test('static app loads with strict CSP, no secrets or directory traversal exposed', async t => {
  const f = await fixture(t);
  const response = await f.request('/');
  assert.equal(response.status, 200); assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.match(await response.text(), /Plainpost/);
  for (const path of ['/data/key', '/.env', '/server/app.mjs', '/missing']) assert.equal((await f.request(path)).status, 404);
  assert.equal((await f.request('/api/threads')).status, 401);
  const status = await f.status();
  assert.equal(status.configured, false);
  assert.equal(status.b4Relay, false);
  assert.equal((await f.request('/api/connect/b4', { method: 'POST', body: {} })).status, 400);
  assert.match((await f.request('/auth/start', { redirect: 'manual' })).headers.get('location'), /setup_required/);
});

test('home IMAP connection protects secrets, verifies login, tracks replacement draft IDs and account changes', async t => {
  let mail = { configured: true, path: '/home/test/.config/plainpost/mail.conf', email: 'kernel@gmail.com', from: 'Kernel Hacker <kernel@gmail.com>', imap: { auth: { pass: 'secret-password' } } };
  let verified = 0, sent = 0;
  const f = await fixture(t, { mailConfigLoader: async () => mail, imapFactory: () => ({
    from: mail.from, async verify() { verified++; }, async list() { return { threads: [] }; },
    async saveDraft(raw, thread, id) { assert.match(raw, /From: "Kernel Hacker" <kernel@gmail.com>/); assert.equal(id, 'old-draft'); return { id: 'new-draft' }; },
    async sendDraft(id) { assert.equal(id, 'new-draft'); sent++; return { ok: true }; }
  }) });
  const status = await f.status(); assert.equal(status.mail.configured, true); assert.doesNotMatch(JSON.stringify(status), /secret-password|auth/);
  assert.equal((await f.request('/api/connect/imap', { method: 'POST', body: {}, headers: { 'X-CSRF-Token': '' } })).status, 403);
  assert.equal(verified, 0);
  assert.equal((await f.request('/api/connect/imap', { method: 'POST', body: {} })).status, 200);
  assert.equal(verified, 1); assert.equal((await f.status()).provider, 'imap');
  const input = { to: 'list@kernel.org', subject: 'patch', body: 'text', draftId: 'old-draft', sendKey: 'imap-send-request-key' };
  assert.equal((await f.request('/api/send', { method: 'POST', body: input })).status, 200);
  assert.equal((await f.request('/api/send', { method: 'POST', body: input })).status, 200); assert.equal(sent, 1);
  mail = { ...mail, email: 'other@gmail.com' };
  assert.equal((await f.status()).connected, false);
  assert.equal((await f.request('/api/threads')).status, 401);
});
test('b4 relay config requires an HTTPS endpoint and a single sender', () => {
  assert.equal(loadB4RelayConfig({}), null);
  const env = { B4_RELAY_URL: 'https://relay.example.org/_b4_submit', B4_RELAY_FROM: 'Patch Author <author@example.org>' };
  assert.deepEqual(loadB4RelayConfig(env), {
    endpoint: env.B4_RELAY_URL, from: env.B4_RELAY_FROM, email: 'author@example.org', patatt: 'patatt'
  });
  assert.throws(() => loadB4RelayConfig({ ...env, B4_RELAY_URL: 'http://relay.example.org' }), /HTTPS/);
  assert.throws(() => loadB4RelayConfig({ ...env, B4_RELAY_FROM: 'a@example.org, b@example.org' }), /one verified email/);
});

test('b4 relay signs and submits reviewed plain mail without a Gmail connection', { skip: process.platform === 'win32' }, async t => {
  const b4Relay = loadB4RelayConfig({ B4_RELAY_URL: 'https://relay.example.org/_b4_submit', B4_RELAY_FROM: 'Patch Author <author@example.org>' });
  const archive = Buffer.from('From: Other Author <other@example.org>\nTo: list@kernel.org\nSubject: [PATCH] first version\nMessage-ID: <root@example.org>\n\nInitial message\n');
  const submissions = [];
  const f = await fixture(t, {
    config: { b4Relay },
    fetcher: async (url, options) => {
      if (String(url).startsWith('https://lore.kernel.org/')) return new Response(gzipSync(toMbox([archive])));
      assert.equal(url, b4Relay.endpoint);
      assert.equal(options.method, 'POST');
      assert.equal(options.redirect, 'error');
      const { action, messages } = JSON.parse(options.body);
      assert.equal(action, 'receive');
      assert.equal(messages.length, 1);
      submissions.push(messages[0]);
      if (messages[0].includes('Subject: [PATCH] rejected')) {
        return Response.json({ result: 'error', message: 'Destinations must include a recognized list.' }, { status: 500 });
      }
      return Response.json({ result: 'success' });
    }
  });
  b4Relay.patatt = join(f.dir, 'patatt');
  await writeFile(b4Relay.patatt, "#!/bin/sh\n[ \"$1\" = sign ] || exit 1\nprintf 'X-Developer-Signature: test\\n'\ncat\n", { mode: 0o700 });
  const post = (path, body, headers) => f.request(path, { method: 'POST', body, headers });
  const status = await f.status();
  assert.equal(status.b4Relay, true);
  assert.equal(status.configured, false);
  assert.equal(status.connected, false);
  assert.equal((await post('/api/send', {})).status, 401);
  const thread = await (await post('/api/lore/import', { url: 'https://lore.kernel.org/lkml/root@example.org/' })).json();
  assert.equal((await post('/api/connect/b4', {}, { 'X-CSRF-Token': '' })).status, 403);
  assert.equal((await post('/api/connect/b4', {})).status, 200);
  const connected = await f.status();
  assert.equal(connected.provider, 'b4');
  assert.equal(connected.email, 'author@example.org');
  assert.equal(connected.from, 'Patch Author <author@example.org>');
  assert.doesNotMatch(JSON.stringify(connected), /relay\.example\.org|patatt/);
  assert.equal((await f.request('/api/lore/threads/' + thread.id + '/mbox')).status, 200);
  assert.equal((await f.request('/api/threads')).status, 405);
  assert.equal((await post('/api/drafts', {})).status, 405);

  const body = 'Café fixes spacing.\n\n--- a/file\n+++ b/file\n@@ -1 +1 @@\n-old\n+\tnew  \n';
  const message = {
    to: 'list@kernel.org', cc: 'reviewer@example.org', subject: '[PATCH v2] preserve formatting',
    body, inReplyTo: '<root@example.org>', references: '<root@example.org>', sendKey: 'b4-relay-send-test-1'
  };
  assert.equal((await post('/api/send', { ...message, bcc: 'private@example.org' })).status, 400);
  assert.equal((await post('/api/send', { ...message, draftId: 'gmail-draft' })).status, 400);
  const sends = await Promise.all([post('/api/send', message), post('/api/send', message)]);
  assert.deepEqual(sends.map(response => response.status), [200, 200]);
  assert.equal(submissions.length, 1);
  const headers = submissions[0].split('\n\n', 1)[0];
  assert.match(headers, /^X-Developer-Signature: test$/m);
  assert.match(headers, /^From: "Patch Author" <author@example\.org>$/m);
  assert.match(headers, /^To: list@kernel\.org$/m);
  assert.match(headers, /^Cc: reviewer@example\.org$/m);
  assert.match(headers, /^In-Reply-To: <root@example\.org>$/m);
  assert.match(headers, /^References: <root@example\.org>$/m);
  assert.match(headers, /^Content-Type: text\/plain; charset=UTF-8$/m);
  assert.doesNotMatch(submissions[0], /\r/);
  assert.equal(submissions[0].slice(headers.length + 2), body);

  const rejected = { ...message, subject: '[PATCH] rejected', sendKey: 'b4-relay-send-test-2' };
  for (let i = 0; i < 2; i++) {
    const response = await post('/api/send', rejected);
    assert.equal(response.status, 502);
    assert.match((await response.json()).error, /Destinations must include a recognized list/);
  }
  assert.equal(submissions.length, 2);
  b4Relay.patatt += '-missing';
  const unsigned = await post('/api/send', { ...message, sendKey: 'b4-relay-send-test-3' });
  assert.equal(unsigned.status, 502);
  assert.match((await unsigned.json()).error, /Could not sign with patatt/);
  assert.equal(submissions.length, 2);
});

test('writes reject missing CSRF, foreign origin, cross-site requests and DNS rebinding hosts', async t => {
  const f = await fixture(t); await f.status();
  for (const headers of [{ 'X-CSRF-Token': '' }, { 'X-CSRF-Token': 'é'.repeat(43) }, { Origin: 'https://evil.example.org' }, { 'Sec-Fetch-Site': 'cross-site' }]) assert.equal((await f.request('/api/demo', { method: 'POST', body: {}, headers })).status, 403, JSON.stringify(headers));
  // Native fetch normalizes Host; use HTTP to exercise an actual rebinding request.
  const hostStatus = await new Promise((resolve, reject) => {
    const request = httpRequest(f.config.appUrl + '/api/status', { headers: { Host: 'evil.example.org' } }, response => { response.resume(); resolve(response.statusCode); });
    request.on('error', reject); request.end();
  });
  assert.equal(hostStatus, 403);
  assert.equal((await f.request('/api/status', { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
});
test('anonymous lore imports require CSRF; raw and mbox downloads are session scoped and bounded', async t => {
  const raw = Buffer.from('From: Author <author@example.org>\nTo: list@kernel.org\nSubject: [PATCH] archive only\nMessage-ID: <root@example.org>\nContent-Type: text/plain; charset=UTF-8\n\n+\tpreserve tabs  \n');
  let calls = 0;
  const fetcher = async url => { calls++; assert.match(url, /^https:\/\/lore\.kernel\.org\/all\//); return new Response(gzipSync(toMbox([raw]))); };
  const f = await fixture(t, { fetcher });
  assert.equal((await f.status()).connected, false);
  const stranger = await fetch(f.config.appUrl + '/api/status');
  const strangerCookie = stranger.headers.get('set-cookie').split(';')[0];
  await stranger.arrayBuffer();
  const input = { url: 'https://lore.kernel.org/lkml/root@example.org/' };
  assert.equal((await f.request('/api/lore/import', { method: 'POST', body: input, headers: { 'X-CSRF-Token': '' } })).status, 403);
  assert.equal(calls, 0);
  const response = await f.request('/api/lore/import', { method: 'POST', body: input }); assert.equal(response.status, 200);
  const thread = await response.json(); assert.equal(thread.source, 'lore'); assert.equal(thread.messages[0].threadId, '');
  const path = `/api/lore/threads/${thread.id}`;
  assert.equal(await (await f.request(`${path}/messages/${thread.messages[0].id}/raw`)).text(), raw.toString());
  assert.match(await (await f.request(`${path}/mbox`)).text(), /\+\tpreserve tabs  /);
  assert.equal((await f.request(`${path}/mbox`, { headers: { Cookie: strangerCookie } })).status, 404);
  assert.equal((await f.request(`/api/threads/${thread.id}`)).status, 401);
  assert.equal((await f.request('/api/lore/import', { method: 'POST', body: { url: 'https://localhost/private' } })).status, 400);
  assert.equal(calls, 1);
  for (let i = 1; i <= 3; i++) assert.equal((await f.request('/api/lore/import', { method: 'POST', body: { url: `https://lore.kernel.org/all/other${i}@example.org/` } })).status, 200);
  assert.equal((await f.request(`${path}/mbox`)).status, 404);
  assert.equal((await f.request('/threading.js')).status, 200);
});

test('isolated demo supports list filters, read/star/archive/trash/restore and raw exports', async t => {
  const f = await fixture(t); await f.demo();
  const result = await (await f.request('/api/threads?q=in:inbox')).json(); assert.equal(result.threads.length, 10);
  const filtered = await (await f.request('/api/threads?q=list:linux-mm.kvack.org')).json(); assert.equal(filtered.threads.length, 2);
  const id = result.threads[0].id;
  let thread = await (await f.request(`/api/threads/${id}`)).json(); assert.match(thread.messages[0].body, /\+\t/);
  for (const body of [{ add: ['STARRED'], remove: ['UNREAD'] }, { remove: ['INBOX'] }, { add: ['TRASH'] }, { add: ['INBOX'], remove: ['TRASH'] }]) assert.equal((await f.request(`/api/threads/${id}/modify`, { method: 'POST', body })).status, 200);
  assert.equal((await f.request(`/api/threads/${id}/modify`, { method: 'POST', body: { add: ['PERMANENT_DELETE'] } })).status, 400);
  assert.match(await (await f.request(`/api/messages/${thread.messages[0].id}/raw`)).text(), /Content-Type: text\/plain/);
  assert.match(await (await f.request(`/api/threads/${id}/mbox`)).text(), /^From plainpost@localhost/);
});
test('send attempts are deduplicated and messages are threaded with plain text', async t => {
  const f = await fixture(t); await f.demo();
  const message = { to: 'reviewer@example.org', subject: 'Re: [PATCH v3 1/2] sched: recheck affinity during task wakeup', body: 'Reviewed-by: You <you@example.org>\n\tSpacing  \n', inReplyTo: '<demo-1.1@example.org>', references: '<demo-1.1@example.org>', threadId: 'demo-1', sendKey: 'dedupe-send-test-0001' };
  const responses = await Promise.all([f.request('/api/send', { method: 'POST', body: message }), f.request('/api/send', { method: 'POST', body: message })]);
  const ids = await Promise.all(responses.map(r => r.json())); assert.equal(ids[0].id, ids[1].id);
  assert.equal((await (await f.request('/api/threads/demo-1')).json()).messages.length, 4);
  const raw = await (await f.request(`/api/messages/${ids[0].id}/raw`)).text(); assert.match(raw, /In-Reply-To: <demo-1.1@example.org>/); assert.match(raw, /\tSpacing  /);
  assert.equal((await f.request('/api/send', { method: 'POST', body: { ...message, body: 'Changed message' } })).status, 409);
  assert.equal((await f.request('/api/send', { method: 'POST', body: { ...message, to: 'invalid', sendKey: 'another-send-key-0002' } })).status, 400);
});
test('draft creation, update and send consumes the draft once; logout clears access', async t => {
  const f = await fixture(t); await f.demo();
  const input = { to: 'reviewer@example.org', cc: 'list@kernel.org', bcc: 'private@example.org', subject: 'Draft', body: 'original\n' };
  const draft = await (await f.request('/api/drafts', { method: 'POST', body: input })).json();
  const saved = await (await f.request(`/api/drafts/${draft.id}`)).json(); assert.equal(saved.bcc, 'private@example.org');
  const updated = { ...input, body: 'updated\n', draftId: draft.id };
  const update = await (await f.request('/api/drafts', { method: 'POST', body: updated })).json(); assert.equal(update.id, draft.id);
  const sent = await f.request('/api/send', { method: 'POST', body: { ...updated, sendKey: 'draft-send-key-0000001' } }); assert.equal(sent.status, 200);
  assert.equal((await (await f.request('/api/drafts')).json()).drafts.length, 0);
  assert.equal((await f.request('/api/logout', { method: 'POST', body: {} })).status, 200);
  assert.equal((await f.request('/api/threads')).status, 401);
});
test('OAuth uses state and PKCE, validates scopes, stores tokens encrypted, and survives restart', async t => {
  let exchange;
  const fetcher = async (url, options) => {
    if (String(url).includes('/token')) { exchange = new URLSearchParams(options.body); return Response.json({ access_token: 'secret-access-token', refresh_token: 'secret-refresh-token', expires_in: 3600, scope: GMAIL_SCOPE }); }
    if (String(url).endsWith('/profile')) return Response.json({ emailAddress: 'developer@gmail.com' });
    throw new Error('Unexpected Google API request');
  };
  const f = await fixture(t, { config: { clientId: 'client', clientSecret: 'secret' }, fetcher }); await f.status();
  const response = await f.request('/auth/start', { redirect: 'manual' }); const auth = new URL(response.headers.get('location'));
  assert.equal(auth.hostname, 'accounts.google.com'); assert.equal(auth.searchParams.get('code_challenge_method'), 'S256'); assert.equal(auth.searchParams.get('access_type'), 'offline');
  const state = auth.searchParams.get('state'); assert.ok(state.length > 32);
  const invalid = await f.request('/auth/callback?state=wrong&code=test', { redirect: 'manual' }); assert.match(invalid.headers.get('location'), /invalid_state/);
  const callback = await f.request(`/auth/callback?state=${state}&code=test`, { redirect: 'manual' }); assert.equal(callback.headers.get('location'), '/');
  assert.equal(exchange.get('code'), 'test'); assert.equal(exchange.get('redirect_uri'), `${f.config.appUrl}/auth/callback`); assert.ok(exchange.get('code_verifier'));
  assert.equal((await f.status()).email, 'developer@gmail.com');
  const text = await readFile(join(f.dir, 'vault.json'), 'utf8'); assert.doesNotMatch(text, /secret-access-token|secret-refresh-token|developer@gmail.com/);
  const restored = await new Vault(f.dir).init(); assert.equal(restored.data.accounts['developer@gmail.com'].refreshToken, 'secret-refresh-token');
  assert.match((await f.request(`/auth/callback?state=${state}&code=test`, { redirect: 'manual' })).headers.get('location'), /invalid_state/);
  await f.request('/api/logout', { method: 'POST', body: {} }); assert.equal(Object.keys(f.vault.data.accounts).length, 0);
});
test('OAuth with a different browser session cannot complete the flow', async t => {
  const f = await fixture(t, { config: { clientId: 'client', clientSecret: 'secret' } }); await f.status();
  const auth = new URL((await f.request('/auth/start', { redirect: 'manual' })).headers.get('location'));
  const response = await f.request(`/auth/callback?state=${auth.searchParams.get('state')}&code=test`, { redirect: 'manual', headers: { Cookie: 'plainpost_session=wrong-session' } });
  assert.match(response.headers.get('location'), /invalid_state/);
});
test('parallel Gmail reads share refresh, include Bearer auth, decode plain parts and external bodies', async t => {
  const f = await fixture(t); let refreshes = 0, attachments = 0;
  f.vault.data.accounts['dev@gmail.com'] = { refreshToken: 'refresh', expiresAt: 0 };
  const fetcher = async (url, options) => {
    if (String(url).includes('/token')) { ++refreshes; await new Promise(r => setTimeout(r, 10)); return Response.json({ access_token: 'fresh', expires_in: 3600 }); }
    assert.equal(options.headers.Authorization, 'Bearer fresh');
    if (String(url).includes('/attachments/')) { ++attachments; return Response.json({ data: Buffer.from('patch\n+\tline  \n').toString('base64url') }); }
    return Response.json({ id: 't', messages: [{ id: 'm', threadId: 't', labelIds: ['INBOX'], internalDate: '1', payload: { mimeType: 'multipart/alternative', headers: [{ name: 'Subject', value: 'Test' }], parts: [{ mimeType: 'text/html', body: { data: 'aW52YWxpZA' } }, { mimeType: 'text/plain', body: { attachmentId: 'external-body' } }] } }] });
  };
  const gmail = new Gmail(f.config, f.vault, 'dev@gmail.com', fetcher);
  const threads = await Promise.all([gmail.thread('t'), gmail.thread('t')]);
  assert.equal(refreshes, 1); assert.equal(attachments, 2); assert.equal(threads[0].messages[0].body, 'patch\n+\tline  \n');
});
test('Gmail mutations are never retried automatically after an uncertain error', async t => {
  const f = await fixture(t); f.vault.data.accounts['dev@gmail.com'] = { accessToken: 'valid', expiresAt: Date.now() + 3600000 }; let attempts = 0;
  const gmail = new Gmail(f.config, f.vault, 'dev@gmail.com', async () => { ++attempts; throw new Error('network interrupted'); });
  await assert.rejects(() => gmail.send('message'), /may have completed/); assert.equal(attempts, 1);
});

test('Gmail draft resources retain the draft ID independently from their message ID', async t => {
  const f = await fixture(t); f.vault.data.accounts['dev@gmail.com'] = { accessToken: 'valid', expiresAt: Date.now() + 3600000 };
  const calls = [];
  const gmail = new Gmail(f.config, f.vault, 'dev@gmail.com', async (url, options) => {
    calls.push({ path: new URL(url).pathname, method: options.method });
    return Response.json({ id: 'draft-123', message: { id: 'message-456', threadId: 'thread-789', payload: { mimeType: 'text/plain', headers: [{ name: 'Subject', value: 'Draft' }], body: { data: Buffer.from('patch\n').toString('base64url') } } } });
  });
  const draft = await gmail.draft('draft-123'); assert.equal(draft.id, 'draft-123'); assert.equal(draft.messageIdResource, 'message-456');
  await gmail.saveDraft('plain message', draft.threadId, draft.id);
  assert.equal(calls[1].path, '/gmail/v1/users/me/drafts/draft-123'); assert.equal(calls[1].method, 'PUT');
});

test('b4 patch series previews all messages and signs the reviewed snapshot in one request', { skip: process.platform === 'win32' }, async t => {
  const b4Relay = loadB4RelayConfig({ B4_RELAY_URL: 'https://relay.example.org/_b4_submit', B4_RELAY_FROM: 'Author <author@example.org>' });
  const submissions = [];
  const f = await fixture(t, { config: { b4Relay }, fetcher: async (url, options) => {
    assert.equal(url, b4Relay.endpoint);
    submissions.push(JSON.parse(options.body));
    return Response.json({ result: 'success' });
  } });
  b4Relay.patatt = join(f.dir, 'patatt');
  const signedHeader = 'X-Developer-Signature: test\n';
  await writeFile(b4Relay.patatt, "#!/bin/sh\n[ \"$1\" = sign ] || exit 1\nprintf 'X-Developer-Signature: test\\n'\ncat\n", { mode: 0o700 });
  const cover = '[PATCH v2 0/2] Cover';
  const first = '[PATCH v2 1/2] Change C';
  const second = '[PATCH v2 2/2] Change Python';
  const c = 'diff --git a/a.c b/a.c\n--- a/a.c\n+++ b/a.c\n@@ -1 +1 @@\n-\treturn 1;\n+\treturn 2;  \n';
  const python = 'diff --git a/a.py b/a.py\n--- a/a.py\n+++ b/a.py\n@@ -1 +1 @@\n-return 1\n+return 2\n';
  const source = (subject, body, headers = '') => `From: Author <author@example.org>\nTo: list@example.org\nSubject: ${subject}\n${headers}\n${body}`;
  const coverFile = join(f.dir, 'z-cover.eml');
  await writeFile(coverFile, source(cover, 'Cover letter\n', 'Message-ID: <series@example.org>\nX-B4-Tracking: v=1; b=ZXhh\n bXBsZQ==\nX-Change-ID: 20261124-example\n'));
  await writeFile(join(f.dir, 'y-first.patch'), source(first, c));
  await writeFile(join(f.dir, 'x-second.eml'), source(second, python).replace('Author <author@example.org>', 'Other Author <other@example.org>'));
  const post = (route, body) => f.request('/api/patch-series/' + route, { method: 'POST', body });
  await f.status();
  assert.equal((await post('load', { path: f.dir })).status, 401);
  assert.equal((await f.request('/api/connect/b4', { method: 'POST', body: {} })).status, 200);
  await f.status();
  assert.equal((await post('load', { path: coverFile })).status, 400);
  const loaded = await post('load', { path: f.dir });
  assert.equal(loaded.status, 200);
  const { id, messages } = await loaded.json();
  assert.deepEqual(messages.map(message => message.subject), [cover, first, second]);
  const edits = messages.map(({ to, cc, subject, body }) => ({ to, cc, subject, body }));
  edits[1].to = 'list@example.org, LIST@example.org';
  edits[1].cc = 'list@example.org, maintainer@example.org';
  edits[0].body = 'Reviewed cover\n';
  const stale = await (await post('preview', { id, messages: edits })).json();
  edits[1].body += '\nEdited before final review.\n';
  const reviewed = await (await post('preview', { id, messages: edits })).json();
  assert.match(reviewed.messages[0].raw, /Message-ID: <series@example.org>/);
  assert.match(reviewed.messages[0].raw, /X-B4-Tracking: v=1; b=ZXhh bXBsZQ==\nX-Change-ID: 20261124-example\n/);
  assert.match(reviewed.messages[1].raw, /To: list@example.org\nCc: maintainer@example.org\n/);
  assert.match(reviewed.messages[1].raw, /In-Reply-To: <series@example.org>\nReferences: <series@example.org>\n/);
  assert.ok(reviewed.messages[1].raw.endsWith(c + '\nEdited before final review.\n'));
  assert.ok(reviewed.messages[2].raw.endsWith('From: Other Author <other@example.org>\n\n' + python));
  assert.equal((await post('send', { id: stale.id })).status, 409);
  assert.deepEqual(submissions, []);
  const result = await Promise.all([post('send', { id: reviewed.id }), post('send', { id: reviewed.id })]);
  for (const response of result) assert.deepEqual(await response.json(), { ok: true, count: 3 });
  assert.deepEqual(submissions, [{ action: 'receive', messages: reviewed.messages.map(message => signedHeader + message.raw) }]);
});

test('b4 patch import accepts a git format-patch stdout file', async t => {
  const { loadPatchSeries } = await import('../server/patch-series.mjs');
  const f = await fixture(t);
  const path = join(f.dir, 'series.mbox');
  const message = number => `From ${'0'.repeat(40)} Mon Sep 17 00:00:00 2001\r\nFrom: Author <author@example.org>\r\nSubject: [fixture] [PATCH ${number}/2] Update file\r\n\r\ndiff --git a/a b/a\r\n--- a/a\r\n+++ b/a\r\n@@ -1 +1 @@\r\n-old\r\n+new\r\n`;
  await writeFile(path, message(2) + message(1));
  assert.deepEqual((await loadPatchSeries(path)).map(item => item.sequence.number), [1, 2]);
  await writeFile(path, message(1) + message(1));
  await assert.rejects(loadPatchSeries(path), /missing or duplicate patch numbers/);
});
