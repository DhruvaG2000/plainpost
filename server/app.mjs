import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { AppError, buildRawMail, toMbox } from './mail.mjs';
import { Gmail, GMAIL_SCOPE, exchangeToken, googleRequest } from './gmail.mjs';
import { DemoMailbox } from './demo.mjs';
import { fetchLore } from './lore.mjs';
import { loadMailConfig, publicMailConfig } from './mail-config.mjs';
import { ImapMailbox } from './imap.mjs';
import { sendViaB4Relay } from './b4-relay.mjs';

const publicDir = fileURLToPath(new URL('../public/', import.meta.url));
const hash = value => createHash('sha256').update(value).digest('hex');
const random = () => randomBytes(32).toString('base64url');
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const cookies = req => Object.fromEntries((req.headers.cookie || '').split(';').map(s => s.trim().split('=')).filter(p => p.length === 2));
const safeId = value => { if (!/^[a-zA-Z0-9_-]{1,256}$/.test(value || '')) throw new AppError('Invalid resource ID.'); return value; };

export async function createApp(config, vault, { fetcher = fetch, mailConfigLoader = loadMailConfig, imapFactory = settings => new ImapMailbox(settings) } = {}) {
  const flows = new Map(), demoMailboxes = new Map(), sends = new Map();
  const archives = new Map();
  for (const [id, session] of Object.entries(vault.data.sessions)) if (session.expiresAt < Date.now() || !['gmail', 'imap', 'b4'].includes(session.provider)) delete vault.data.sessions[id];

  function setCookie(res, token) { res.setHeader('Set-Cookie', `plainpost_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800`); }
  async function newSession(res, oldId, provider = 'anonymous', email = '') {
    if (oldId) { delete vault.data.sessions[oldId]; demoMailboxes.delete(oldId); }
    const token = random(), id = hash(token);
    vault.data.sessions[id] = { provider, email, csrf: random(), expiresAt: Date.now() + 7 * 86400000 };
    if (provider === 'demo') demoMailboxes.set(id, new DemoMailbox());
    await vault.save(); setCookie(res, token); return { id, session: vault.data.sessions[id] };
  }
  const json = (res, data, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); };
  const redirect = (res, path) => { res.writeHead(303, { Location: path }); res.end(); };
  async function body(req) {
    if (!req.headers['content-type']?.startsWith('application/json')) throw new AppError('Expected JSON.', 415);
    const chunks = []; let size = 0;
    for await (const chunk of req) { size += chunk.length; if (size > 3 * 1024 * 1024) throw new AppError('Request too large.', 413); chunks.push(chunk); }
    try { const value = JSON.parse(Buffer.concat(chunks).toString()); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(); return value; }
    catch { throw new AppError('Invalid JSON.'); }
  }
  const server = createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    try {
      const origin = new URL(config.appUrl);
      if (req.headers.host !== origin.host) throw new AppError(`Open the app at ${config.appUrl}.`, 403);
      const url = new URL(req.url, origin), path = url.pathname;
      let sessionId = hash(cookies(req).plainpost_session || ''), session = vault.data.sessions[sessionId];
      if (session?.expiresAt < Date.now()) { delete vault.data.sessions[sessionId]; session = undefined; }
      if (path.startsWith('/api/') && req.headers['sec-fetch-site'] === 'cross-site') throw new AppError('Cross-site requests are blocked.', 403);
      if (req.method !== 'GET') {
        if (req.headers.origin !== origin.origin || !equal(req.headers['x-csrf-token'], session?.csrf)) throw new AppError('Session check failed. Refresh the page and try again.', 403);
      }
      if (path === '/api/status' && req.method === 'GET') {
        if (!session) ({ id: sessionId, session } = await newSession(res));
        const mail = await mailConfigLoader();
        let active = true;
        if (session.provider === 'imap') active = mail.configured && mail.email === session.email;
        if (session.provider === 'b4') active = config.b4Relay?.email === session.email;
        const from = session.provider === 'b4' ? config.b4Relay?.from : session.provider === 'imap' ? mail.from : session.email;
        return json(res, { connected: session.provider !== 'anonymous' && active, provider: active ? session.provider : 'anonymous', email: active ? session.email : '', from: active ? from : '', csrf: session.csrf, configured: !!(config.clientId && config.clientSecret), mail: publicMailConfig(mail), b4Relay: !!config.b4Relay, appUrl: config.appUrl });
      }
      if (path === '/api/connect/imap' && req.method === 'POST') {
        await body(req);
        const mail = await mailConfigLoader();
        if (!mail.configured) throw new AppError(mail.error || 'Configure Gmail in your home directory first.');
        await imapFactory(mail).verify();
        await newSession(res, sessionId, 'imap', mail.email);
        return json(res, { ok: true });
      }
      if (path === '/api/connect/b4' && req.method === 'POST') {
        await body(req);
        if (!config.b4Relay) throw new AppError('Configure the b4 relay on the Plainpost server first.');
        const result = await newSession(res, sessionId, 'b4', config.b4Relay.email);
        for (const [key, entry] of archives) {
          if (key.startsWith(sessionId + ':')) {
            archives.delete(key);
            archives.set(result.id + key.slice(sessionId.length), entry);
          }
        }
        return json(res, { ok: true });
      }
      if (path.startsWith('/api/lore/')) {
        if (!session) throw new AppError('Refresh Plainpost before importing a thread.', 401);
        for (const [key, entry] of archives) if (entry.expiresAt < Date.now()) archives.delete(key);
        if (path === '/api/lore/import' && req.method === 'POST') {
          const input = await body(req), entry = await fetchLore(input.url, fetcher);
          // A bounded, ephemeral cache; archive mail never becomes a Gmail resource.
          while (archives.size >= 3) archives.delete(archives.keys().next().value);
          archives.set(`${sessionId}:${entry.thread.id}`, { ...entry, expiresAt: Date.now() + 30 * 60000 });
          return json(res, entry.thread);
        }
        const match = path.match(/^\/api\/lore\/threads\/([^/]+)\/(mbox|messages\/([^/]+)\/raw)$/);
        if (match && req.method === 'GET') {
          const entry = archives.get(`${sessionId}:${safeId(match[1])}`);
          if (!entry) throw new AppError('Archive download expired. Fetch the lore link again.', 404);
          const raw = match[2] === 'mbox' ? entry.mbox : entry.rawMap.get(safeId(match[3]));
          if (!raw) throw new AppError('Archive message not found.', 404);
          res.writeHead(200, { 'Content-Type': match[2] === 'mbox' ? 'application/mbox' : 'message/rfc822', 'Content-Disposition': `attachment; filename="${match[2] === 'mbox' ? 'thread.mbox' : 'message.eml'}"` }); return res.end(raw);
        }
        throw new AppError('Archive endpoint not found.', 404);
      }
      if (path === '/api/demo' && req.method === 'POST') { await body(req); const result = await newSession(res, sessionId, 'demo', 'you@example.org'); return json(res, { ok: true, csrf: result.session.csrf }); }
      if (path === '/api/logout' && req.method === 'POST') {
        await body(req);
        if (['gmail', 'imap'].includes(session.provider)) {
          if (session.provider === 'gmail') delete vault.data.accounts[session.email];
          for (const [id, s] of Object.entries(vault.data.sessions)) if (s.email === session.email) delete vault.data.sessions[id];
        }
        await newSession(res, sessionId); return json(res, { ok: true });
      }
      if (path === '/auth/start' && req.method === 'GET') {
        if (!config.clientId || !config.clientSecret) return redirect(res, '/?auth_error=setup_required');
        if (!session || req.headers['sec-fetch-site'] === 'cross-site') throw new AppError('Open Plainpost first, then connect Gmail.', 403);
        for (const [key, flow] of flows) if (flow.expiresAt < Date.now()) flows.delete(key);
        const state = random(), verifier = random();
        flows.set(state, { verifier, sessionId, expiresAt: Date.now() + 10 * 60000 });
        const auth = new URL('https://accounts.google.com/o/oauth2/v2/auth');
        const params = { client_id: config.clientId, redirect_uri: `${origin.origin}/auth/callback`, response_type: 'code', scope: GMAIL_SCOPE, access_type: 'offline', prompt: 'consent', state, code_challenge: hashBase64(verifier), code_challenge_method: 'S256' };
        Object.entries(params).forEach(([key, value]) => auth.searchParams.set(key, value));
        return redirect(res, auth.href);
      }
      if (path === '/auth/callback' && req.method === 'GET') {
        const state = url.searchParams.get('state'), flow = flows.get(state);
        flows.delete(state);
        if (!flow || flow.sessionId !== sessionId || flow.expiresAt < Date.now()) return redirect(res, '/?auth_error=invalid_state');
        if (url.searchParams.has('error')) return redirect(res, '/?auth_error=denied');
        const code = url.searchParams.get('code');
        if (!code) return redirect(res, '/?auth_error=missing_code');
        try {
          const token = await exchangeToken(config, { code, grant_type: 'authorization_code', redirect_uri: `${origin.origin}/auth/callback`, code_verifier: flow.verifier }, fetcher);
          if (!token.access_token || !(token.scope || '').split(' ').includes(GMAIL_SCOPE)) throw new AppError('The required Gmail permission was not granted.', 401);
          const profile = await googleRequest('https://gmail.googleapis.com/gmail/v1/users/me/profile', { headers: { Authorization: `Bearer ${token.access_token}` } }, fetcher);
          vault.data.accounts[profile.emailAddress] = { accessToken: token.access_token, refreshToken: token.refresh_token || vault.data.accounts[profile.emailAddress]?.refreshToken, expiresAt: Date.now() + token.expires_in * 1000 };
          await newSession(res, sessionId, 'gmail', profile.emailAddress);
          return redirect(res, '/');
        } catch { return redirect(res, '/?auth_error=exchange_failed'); }
      }
      if (path.startsWith('/api/')) {
        if (!session || session.provider === 'anonymous') throw new AppError('Connect Gmail or b4 relay, or open the demo mailbox.', 401);
        let mailbox;
        if (session.provider === 'imap') {
          const mail = await mailConfigLoader();
          if (!mail.configured || mail.email !== session.email) throw new AppError('Mail settings changed. Open settings and connect Gmail again.', 401);
          mailbox = imapFactory(mail);
        } else if (session.provider === 'b4') {
          const relay = config.b4Relay;
          if (relay?.email !== session.email) throw new AppError('Relay settings changed. Connect b4 relay again.', 401);
          if (path !== '/api/send' || req.method !== 'POST') throw new AppError('b4 relay provides outgoing delivery only.', 405);
          mailbox = { from: relay.from, send: raw => sendViaB4Relay(relay, raw, fetcher) };
        } else mailbox = session.provider === 'demo' ? demoMailboxes.get(sessionId) : new Gmail(config, vault, session.email, fetcher);
        if (!mailbox) throw new AppError('Demo session expired. Open the demo again.', 401);
        if (path === '/api/labels' && req.method === 'GET') return json(res, { labels: await mailbox.labels() });
        if (path === '/api/threads' && req.method === 'GET') return json(res, await mailbox.list({ q: url.searchParams.get('q') || 'in:inbox', pageToken: url.searchParams.get('pageToken') || '' }));
        const threadMatch = path.match(/^\/api\/threads\/([^/]+)(?:\/(modify|mbox))?$/);
        if (threadMatch) {
          const id = safeId(threadMatch[1]);
          if (!threadMatch[2] && req.method === 'GET') return json(res, await mailbox.thread(id));
          if (threadMatch[2] === 'modify' && req.method === 'POST') {
            const input = await body(req), allowed = ['UNREAD', 'STARRED', 'INBOX', 'TRASH'];
            for (const labels of [input.add || [], input.remove || []]) if (!Array.isArray(labels) || labels.some(l => !allowed.includes(l))) throw new AppError('Unsupported mailbox action.');
            return json(res, await mailbox.modify(id, input.add || [], input.remove || []));
          }
          if (threadMatch[2] === 'mbox' && req.method === 'GET') {
            const thread = await mailbox.thread(id), raws = [];
            for (const message of thread.messages) raws.push(await mailbox.raw(message.id));
            res.writeHead(200, { 'Content-Type': 'application/mbox', 'Content-Disposition': `attachment; filename="thread-${id}.mbox"` }); return res.end(toMbox(raws));
          }
        }
        const rawMatch = path.match(/^\/api\/messages\/([^/]+)\/raw$/);
        if (rawMatch && req.method === 'GET') { const id = safeId(rawMatch[1]), raw = await mailbox.raw(id); res.writeHead(200, { 'Content-Type': 'message/rfc822', 'Content-Disposition': `attachment; filename="message-${id}.eml"` }); return res.end(raw); }
        const attachmentMatch = path.match(/^\/api\/messages\/([^/]+)\/attachments\/([^/]+)$/);
        if (attachmentMatch && req.method === 'GET') { const data = await mailbox.attachment(safeId(attachmentMatch[1]), safeId(attachmentMatch[2])); res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="attachment.bin"' }); return res.end(data); }
        if (path === '/api/drafts' && req.method === 'GET') return json(res, await mailbox.drafts({ pageToken: url.searchParams.get('pageToken') || '' }));
        const draftMatch = path.match(/^\/api\/drafts\/([^/]+)$/);
        if (draftMatch && req.method === 'GET') return json(res, await mailbox.draft(safeId(draftMatch[1])));
        if ((path === '/api/send' || path === '/api/drafts') && req.method === 'POST') {
          const input = await body(req);
          if (session.provider === 'b4' && (input.bcc || input.draftId)) {
            throw new AppError('b4 relay supports To and Cc and drafts kept in this browser tab.');
          }
          const raw = buildRawMail(input, mailbox.from || session.email);
          const threadId = input.inReplyTo && input.threadId ? safeId(input.threadId) : undefined;
          if (path === '/api/drafts') return json(res, await mailbox.saveDraft(raw, threadId, input.draftId ? safeId(input.draftId) : undefined));
          if (!/^[a-zA-Z0-9_-]{16,100}$/.test(input.sendKey || '')) throw new AppError('Missing send request key.');
          for (const [key, entry] of sends) if (entry.time < Date.now() - 86400000) sends.delete(key);
          const key = `${sessionId}:${input.sendKey}`, fingerprint = hash(JSON.stringify([threadId || '', input.draftId || '', raw.replace(/^Date: .*\r\n/m, '').replace(/^Message-ID: .*\r\n/m, '')]));
          if (sends.has(key)) {
            if (sends.get(key).fingerprint !== fingerprint) throw new AppError('Message changed. Review it again before sending.', 409);
            return json(res, await sends.get(key).promise);
          }
          // Retain failed attempts too: uncertain sends must not be retried blindly.
          const promise = (async () => {
            if (input.draftId) {
              const draftId = safeId(input.draftId);
              const saved = await mailbox.saveDraft(raw, threadId, draftId);
              return mailbox.sendDraft(saved.id || draftId);
            }
            return mailbox.send(raw, threadId);
          })();
          sends.set(key, { fingerprint, promise, time: Date.now() });
          return json(res, await promise);
        }
        throw new AppError('Endpoint not found.', 404);
      }
      if (req.method !== 'GET') throw new AppError('Method not allowed.', 405);
      const files = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/compose.js': ['compose.js', 'text/javascript'], '/threading.js': ['threading.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'], '/favicon.svg': ['favicon.svg', 'image/svg+xml'] };
      if (!files[path]) throw new AppError('Not found.', 404);
      const [file, mime] = files[path], content = await readFile(join(publicDir, file)); res.writeHead(200, { 'Content-Type': `${mime}; charset=utf-8` }); res.end(content);
    } catch (error) {
      if (!res.headersSent) json(res, { error: error.status ? error.message : 'An internal error occurred. Check the server terminal.' }, error.status || 500);
      else res.end();
      if (!error.status) console.error('Plainpost:', error.message);
    }
  });
  server.requestTimeout = 60000; server.headersTimeout = 15000;
  return server;
}

function hashBase64(value) { return createHash('sha256').update(value).digest('base64url'); }
