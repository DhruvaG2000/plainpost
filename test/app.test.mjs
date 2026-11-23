import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { gzipSync } from 'node:zlib';
import { Vault } from '../server/vault.mjs';
import { createApp } from '../server/app.mjs';
import { Gmail, GMAIL_SCOPE } from '../server/gmail.mjs';
import { toMbox } from '../server/mail.mjs';

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
  assert.equal((await f.status()).configured, false);
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
