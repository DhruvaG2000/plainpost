import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { ImapMailbox, imapMessage } from '../server/imap.mjs';
import { buildRawMail } from '../server/mail.mjs';

const config = { email: 'kernel@gmail.com', from: 'Kernel Hacker <kernel@gmail.com>', imap: { host: 'imap.gmail.com', port: 993, secure: true, auth: { user: 'kernel@gmail.com', pass: 'abcdefghijklmnop' } }, smtp: { host: 'smtp.gmail.com', port: 465, secure: true, auth: { user: 'kernel@gmail.com', pass: 'abcdefghijklmnop' } } };
const messageId = (folder, uid, validity = '7') => 'm-' + Buffer.from(JSON.stringify([folder, validity, uid])).toString('base64url');
const threadId = (folder, id) => 't-' + Buffer.from(JSON.stringify([folder, id])).toString('base64url');
const patch = 'diff --git a/file b/file\n+\tvalue  \n\nBcc: this is body text\n';
const raw = buildRawMail({ to: 'list@kernel.org', cc: 'reviewer@kernel.org', bcc: 'private@example.org, other@example.org', subject: '[PATCH] preserve bytes', body: patch, inReplyTo: '<parent@kernel.org>', references: '<root@kernel.org>' }, config.from);

function fixture(rows = []) {
  const events = [], messages = new Map(rows.map(row => [row.uid, { flags: new Set(), labels: new Set(['\\Inbox']), threadId: '90000000000000001', internalDate: new Date(1000 * row.uid), raw: Buffer.from(raw), folder: 'All', ...row }]));
  let uid = 1000, validity = 7n, failSend = false, failDelete = false;
  const clientFactory = options => {
    assert.equal(options.tls.rejectUnauthorized, true); assert.equal(options.logger, false);
    return {
      capabilities: new Set(['X-GM-EXT-1']), usable: true, mailbox: {}, on() {}, close() {}, async connect() { events.push(['connect']); }, async logout() {},
      async list() { return [{ path: 'All', specialUse: '\\All' }, { path: 'Bin', specialUse: '\\Trash' }, { path: 'Drafts', specialUse: '\\Drafts' }]; },
      async mailboxOpen(path) { this.mailbox = { path, uidValidity: validity }; },
      async search(query) {
        events.push(['search', query]);
        return [...messages.values()].filter(m => m.folder === this.mailbox.path && (!query.threadId || query.threadId === m.threadId) && (!query.uid || m.uid <= Number(query.uid.split(':')[1]))).map(m => m.uid);
      },
      async fetchAll(uids) { return uids.map(id => messages.get(id)).filter(Boolean).map(m => ({ ...m, headers: m.raw.subarray(0, m.raw.indexOf('\r\n\r\n')) })); },
      async fetchOne(id) { const m = messages.get(id); return m ? { ...m, size: m.raw.length } : false; },
      async download(id) { return { content: Readable.from([messages.get(id).raw]) }; },
      async append(folder, source) { events.push(['append', folder]); messages.set(++uid, { uid, folder, raw: Buffer.from(source), threadId: '999', flags: new Set(['\\Draft', '\\Seen']), labels: new Set(['\\Drafts']) }); return { uid, uidValidity: validity }; },
      async messageDelete(id) { events.push(['delete', id]); if (failDelete) throw Error('failed'); messages.delete(id); },
      async messageFlagsAdd(ids, flags, options) { events.push(['add', ids, flags, options]); },
      async messageFlagsRemove(ids, flags, options) { events.push(['remove', ids, flags, options]); },
      async messageMove(ids, folder) { events.push(['move', ids, folder]); for (const id of ids) messages.get(id).folder = folder; }
    };
  };
  const smtpFactory = options => {
    assert.equal(options.tls.rejectUnauthorized, true);
    return { close() {}, async verify() { events.push(['verify-smtp']); }, async sendMail(input) { events.push(['send', input]); if (failSend) throw Error('uncertain'); return { messageId: '<smtp@google>', rejected: [] }; } };
  };
  return { mailbox: new ImapMailbox(config, { clientFactory, smtpFactory }), events, messages, expire() { validity++; }, failSend() { failSend = true; }, failDelete() { failDelete = true; } };
}

test('SMTP sends plain RFC822 bytes, keeps reply/patch formatting and hides Bcc only from headers', async () => {
  const f = fixture(); await f.mailbox.verify();
  assert.equal(f.events.some(e => e[0] === 'send'), false);
  await f.mailbox.send(raw);
  const input = f.events.find(e => e[0] === 'send')[1], wire = input.raw.toString();
  assert.deepEqual(input.envelope.to, ['list@kernel.org', 'reviewer@kernel.org', 'private@example.org', 'other@example.org']);
  assert.equal(input.envelope.from, 'kernel@gmail.com');
  assert.doesNotMatch(wire.split('\r\n\r\n')[0], /Bcc:|private@example/);
  assert.match(wire, /Content-Type: text\/plain; charset=UTF-8/);
  assert.match(wire, /In-Reply-To: <parent@kernel.org>/);
  assert.equal(wire.split('\r\n\r\n').slice(1).join('\r\n\r\n'), patch.replace(/\n/g, '\r\n'));
  assert.equal(f.events.some(e => e[0] === 'append'), false);
  const withoutBcc = buildRawMail({ to: 'list@kernel.org', subject: '[PATCH] body header lookalike', body: patch }, config.from);
  await f.mailbox.send(withoutBcc);
  assert.equal(f.events.filter(e => e[0] === 'send').at(-1)[1].raw.toString(), withoutBcc);
});

test('IMAP groups full Gmail threads, preserves 64-bit IDs and rejects stale message UIDs', async () => {
  const f = fixture([{ uid: 1 }, { uid: 2, flags: new Set(['\\Seen']) }]);
  const page = await f.mailbox.list({ q: 'list:linux-kernel.vger.kernel.org' });
  assert.equal(page.threads.length, 1); assert.equal(page.threads[0].count, 2); assert.equal(page.threads[0].unread, true);
  assert.equal(page.threads[0].id, threadId('All', '90000000000000001'));
  assert.equal(f.events.find(e => e[0] === 'search')[1].gmRaw, 'list:linux-kernel.vger.kernel.org');
  const thread = await f.mailbox.thread(page.threads[0].id);
  assert.equal(thread.messages.length, 2); assert.match(thread.messages[0].body, /\+\tvalue  /);
  assert.equal((await f.mailbox.raw(thread.messages[0].id)).toString(), raw);
  f.expire(); await assert.rejects(f.mailbox.raw(thread.messages[0].id), /IDs changed/);
});

test('pagination advances without repeating conversations', async () => {
  const rows = Array.from({ length: 70 }, (_, i) => ({ uid: i + 1, threadId: String(Math.floor(i / 2) + 1) }));
  const f = fixture(rows), first = await f.mailbox.list(), second = await f.mailbox.list({ pageToken: first.nextPageToken });
  assert.equal(first.threads.length, 30); assert.equal(second.threads.length, 5);
  assert.equal(new Set([...first.threads, ...second.threads].map(t => t.id)).size, 35);
  assert.equal(second.nextPageToken, '');
  await assert.rejects(f.mailbox.list({ q: 'in:sent', pageToken: first.nextPageToken }), /Pagination expired/);
});

test('replacing and sending a draft uses its new UID; failures leave the draft intact', async () => {
  const f = fixture([{ uid: 1, folder: 'Drafts' }]);
  const saved = await f.mailbox.saveDraft(raw, undefined, messageId('Drafts', 1));
  assert.equal(saved.id, messageId('Drafts', 1001)); assert.equal(f.messages.has(1), false);
  assert.deepEqual(f.events.filter(e => ['append', 'delete'].includes(e[0])).map(e => e[0]), ['append', 'delete']);
  f.failSend(); await assert.rejects(f.mailbox.sendDraft(saved.id), /uncertain/);
  assert.equal(f.messages.has(1001), true);
  const success = fixture([{ uid: 2, folder: 'Drafts' }]);
  await success.mailbox.sendDraft(messageId('Drafts', 2)); assert.equal(success.messages.has(2), false);
  const cleanup = fixture([{ uid: 3, folder: 'Drafts' }]); cleanup.failDelete();
  assert.match((await cleanup.mailbox.sendDraft(messageId('Drafts', 3))).warning, /Message sent/);
});

test('mailbox actions use flags and labels; trash moves messages without permanent deletion', async () => {
  const f = fixture([{ uid: 1 }]), id = threadId('All', '90000000000000001');
  await f.mailbox.modify(id, ['UNREAD', 'STARRED'], ['INBOX']);
  assert.deepEqual(f.events.filter(e => e[0] === 'remove').map(e => e[2]), [['\\Seen'], ['\\Inbox']]);
  assert.equal(f.events.find(e => e[0] === 'remove' && e[2][0] === '\\Inbox')[3].useLabels, true);
  await f.mailbox.modify(id, ['TRASH'], []);
  assert.equal(f.messages.get(1).folder, 'Bin'); assert.equal(f.events.some(e => e[0] === 'delete'), false);
  await f.mailbox.modify(threadId('Bin', '90000000000000001'), ['INBOX'], ['TRASH']);
  assert.equal(f.messages.get(1).folder, 'INBOX');
});

test('HTML-only mail is not converted; multipart drafts cannot send HTML', async () => {
  const html = Buffer.from('From: a@example.org\r\nSubject: HTML\r\nContent-Type: text/html\r\n\r\n<b>hidden</b>');
  const message = await imapMessage(html, { flags: new Set() }, 'id', 'thread');
  assert.equal(message.hasPlainText, false); assert.equal(message.body, '');
  const mixed = Buffer.from('Content-Type: multipart/alternative; boundary=x\r\n\r\n--x\r\nContent-Type: text/plain\r\n\r\nplain\r\n--x\r\nContent-Type: text/html\r\n\r\n<b>html</b>\r\n--x--\r\n');
  const f = fixture([{ uid: 1, folder: 'Drafts', raw: mixed }]);
  await assert.rejects(f.mailbox.sendDraft(messageId('Drafts', 1)), /Only plain-text drafts/);
  assert.equal(f.events.some(e => e[0] === 'send'), false);
});
