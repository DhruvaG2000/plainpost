import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
import { simpleParser } from 'mailparser';
import { createHash } from 'node:crypto';
import { AppError, addresses, decodeWords, headerValue, messageSummary } from './mail.mjs';
import { plainMime } from './lore.mjs';

const MAX_MESSAGE = 8 * 1024 * 1024;
const queues = new Map();
const pack = value => Buffer.from(JSON.stringify(value)).toString('base64url');
function unpack(value) {
  try { return JSON.parse(Buffer.from(value, 'base64url').toString()); }
  catch { throw new AppError('Invalid IMAP resource ID.'); }
}
const digest = value => createHash('sha256').update(value).digest('hex');
const parseOptions = { skipHtmlToText: true, skipTextToHtml: true, skipImageLinks: true };
function labels(message) {
  const result = [...(message.labels || [])].map(label => ({ '\\Inbox': 'INBOX', '\\Sent': 'SENT', '\\Trash': 'TRASH', '\\Drafts': 'DRAFT' })[label] || label);
  if (!message.flags?.has('\\Seen')) result.push('UNREAD');
  if (message.flags?.has('\\Flagged')) result.push('STARRED');
  return [...new Set(result)];
}
function headers(source) {
  return source.toString('utf8').split(/\r?\n\r?\n/)[0].replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/).map(line => {
    const colon = line.indexOf(':'); return { name: line.slice(0, colon), value: line.slice(colon + 1).trim() };
  }).filter(h => /^[\w-]+$/.test(h.name));
}
export async function imapMessage(source, record, id, threadId) {
  const plain = plainMime(source);
  const parsed = await simpleParser(source, parseOptions);
  const attachments = parsed.attachments.map((a, index) => ({ name: a.filename || 'attachment', id: String(index), mimeType: a.contentType, size: a.size }));
  return { ...messageSummary({ id, threadId, internalDate: +new Date(record.internalDate || parsed.date || 0), labelIds: labels(record), payload: { headers: headers(source) } }), body: plain.bodies.join('\n'), hasPlainText: !!plain.bodies.length, attachments };
}
function summary(id, messages) {
  const first = messages[0] || {}, latest = messages.at(-1) || {};
  return { id, subject: first.subject || '(no subject)', from: latest.from || '', date: latest.date || 0, count: messages.length, snippet: latest.snippet || '', listId: first.listId || latest.listId || '', unread: messages.some(m => m.labelIds.includes('UNREAD')), starred: messages.some(m => m.labelIds.includes('STARRED')), labels: [...new Set(messages.flatMap(m => m.labelIds))] };
}

export class ImapMailbox {
  constructor(config, { clientFactory = options => new ImapFlow(options), smtpFactory = options => nodemailer.createTransport(options) } = {}) {
    this.config = config; this.from = config.from; this.clientFactory = clientFactory; this.smtpFactory = smtpFactory;
  }
  async connection(operation) {
    // Serialize per account: concurrent UI requests cannot exhaust Gmail's connections.
    const key = this.config.email, previous = queues.get(key) || Promise.resolve();
    let release;
    const current = new Promise(resolve => { release = resolve; });
    queues.set(key, current);
    await previous;
    let client;
    try {
      client = this.clientFactory({ ...this.config.imap, logger: false, logRaw: false, disableAutoIdle: true, connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 30000, tls: { rejectUnauthorized: true } });
      client.on('error', () => {});
      await client.connect();
      if (!client.capabilities.has('X-GM-EXT-1')) throw new AppError('This mailbox requires Gmail IMAP extensions. Check the account and IMAP server.', 502);
      return await operation(client);
    } catch (error) {
      if (error.status) throw error;
      throw new AppError(error.authenticationFailed ? 'Gmail rejected the app password. Check 2-Step Verification, App Passwords and your account policy.' : 'IMAP operation interrupted. Check your connection and refresh the mailbox before retrying a change.', error.authenticationFailed ? 401 : 502);
    } finally {
      try { if (client?.usable) await client.logout(); } catch { /* close below */ }
      try { client?.close(); } finally { release(); if (queues.get(key) === current) queues.delete(key); }
    }
  }
  transport() {
    return this.smtpFactory({ ...this.config.smtp, logger: false, debug: false, connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 30000, tls: { rejectUnauthorized: true } });
  }
  async verify() {
    await this.connection(async client => { await client.list(); });
    const transport = this.transport();
    try { await transport.verify(); }
    catch { throw new AppError('Gmail SMTP login failed. Check the app password, SMTP settings and account policy. No message was sent.', 401); }
    finally { transport.close(); }
  }
  async folders(client) {
    const entries = await client.list();
    const path = flag => entries.find(entry => entry.specialUse === flag)?.path;
    return { all: path('\\All'), trash: path('\\Trash'), drafts: path('\\Drafts') };
  }
  async open(client, folder, validity) {
    await client.mailboxOpen(folder);
    if (validity !== undefined && String(client.mailbox.uidValidity) !== String(validity)) throw new AppError('Mailbox IDs changed. Refresh before continuing.', 409);
  }
  async metadata(client, uids, folder, threadId) {
    if (!uids.length) return [];
    const rows = await client.fetchAll(uids, { headers: true, internalDate: true, flags: true, labels: true, threadId: true }, { uid: true });
    return rows.map(row => ({ ...messageSummary({ id: `m-${pack([folder, String(client.mailbox.uidValidity), row.uid])}`, threadId, internalDate: +new Date(row.internalDate || 0), labelIds: labels(row), payload: { headers: headers(row.headers || Buffer.alloc(0)) } }), gmailThreadId: String(row.threadId || '') }));
  }
  async threadUids(client, threadId) {
    if (!/^\d{1,30}$/.test(threadId)) throw new AppError('Invalid Gmail IMAP thread ID.');
    const uids = await client.search({ threadId }, { uid: true });
    if (uids.length > 1000) throw new AppError('This conversation exceeds the 1,000-message limit.', 413);
    if (!uids.length) throw new AppError('Conversation no longer exists here. Refresh the mailbox.', 404);
    return uids;
  }
  async labels() { return ['INBOX', 'STARRED', 'SENT', 'DRAFT', 'TRASH'].map(id => ({ id, name: id })); }
  async list({ q = 'in:inbox', pageToken = '' } = {}) {
    if (q.length > 2000) throw new AppError('Search is too long.');
    return this.connection(async client => {
      const folders = await this.folders(client);
      const folder = /\bin:trash\b/i.test(q) && !/-in:trash\b/i.test(q) ? folders.trash : folders.all;
      if (!folder) throw new AppError('Gmail must expose All Mail and Trash over IMAP. Check Gmail label settings.', 502);
      await this.open(client, folder);
      const validity = String(client.mailbox.uidValidity), key = digest(q);
      let before = Infinity, seen = [];
      if (pageToken) {
        if (pageToken.length > 64000) throw new AppError('Invalid pagination token.');
        const token = unpack(pageToken);
        if (!Array.isArray(token) || token[0] !== folder || token[1] !== validity || token[2] !== key || !Number.isInteger(token[3]) || !Array.isArray(token[4]) || token[4].length > 1000 || token[4].some(id => !/^\d{1,30}$/.test(id))) throw new AppError('Pagination expired. Refresh the mailbox.', 409);
        before = token[3]; seen = token[4];
      }
      const matched = await client.search({ gmRaw: q || 'in:inbox', ...(Number.isFinite(before) ? { uid: `1:${Math.max(1, before - 1)}` } : {}) }, { uid: true });
      const uids = matched.filter(uid => uid < before).sort((a, b) => b - a).slice(0, 300);
      const rows = await this.metadata(client, uids, folder, '');
      rows.sort((a, b) => unpack(b.id.slice(2))[2] - unpack(a.id.slice(2))[2]);
      const selected = [], selectedSet = new Set(seen); let cursor = before;
      for (const row of rows) {
        const tid = row.gmailThreadId;
        if (!/^\d{1,30}$/.test(tid)) throw new AppError('Gmail did not provide thread IDs.', 502);
        if (!selectedSet.has(tid) && selected.length === 30) break;
        cursor = unpack(row.id.slice(2))[2];
        if (!selectedSet.has(tid)) { selected.push(tid); selectedSet.add(tid); }
      }
      const threads = [];
      for (const tid of selected) {
        const id = `t-${pack([folder, tid])}`, members = await this.threadUids(client, tid);
        const messages = await this.metadata(client, members, folder, id);
        messages.sort((a, b) => a.date - b.date);
        threads.push(summary(id, messages));
      }
      threads.sort((a, b) => b.date - a.date);
      const hasMore = matched.some(uid => uid < cursor);
      if (hasMore && selectedSet.size > 1000) throw new AppError('Search is too broad. Narrow the list or date range.');
      return { threads, nextPageToken: hasMore ? pack([folder, validity, key, cursor, [...selectedSet]]) : '', resultSizeEstimate: threads.length };
    });
  }
  async download(client, uid, validity) {
    if (!Number.isSafeInteger(uid) || uid < 1 || String(client.mailbox.uidValidity) !== validity) throw new AppError('Message ID expired. Refresh the mailbox.', 409);
    const row = await client.fetchOne(uid, { size: true, flags: true, labels: true, internalDate: true, threadId: true }, { uid: true });
    if (!row) throw new AppError('Message no longer exists.', 404);
    if (row.size > MAX_MESSAGE) throw new AppError('Message exceeds the 8 MiB download limit.', 413);
    const download = await client.download(uid, undefined, { uid: true, maxBytes: MAX_MESSAGE + 1 });
    const chunks = []; let size = 0;
    for await (const chunk of download.content) { size += chunk.length; if (size > MAX_MESSAGE) throw new AppError('Message exceeds the 8 MiB download limit.', 413); chunks.push(chunk); }
    return { raw: Buffer.concat(chunks), row };
  }
  resource(id, prefix) {
    if (!id.startsWith(prefix + '-')) throw new AppError('Invalid IMAP resource ID.');
    const values = unpack(id.slice(2));
    if (!Array.isArray(values) || typeof values[0] !== 'string' || values[0].length > 120 || /[\x00-\x1f]/.test(values[0])) throw new AppError('Invalid IMAP resource ID.');
    if (prefix === 't' && (values.length !== 2 || !/^\d{1,30}$/.test(values[1]))) throw new AppError('Invalid IMAP thread ID.');
    if (prefix === 'm' && (values.length !== 3 || !/^\d{1,30}$/.test(values[1]) || !Number.isSafeInteger(values[2]) || values[2] < 1)) throw new AppError('Invalid IMAP message ID.');
    return values;
  }
  async thread(id) {
    const [folder, tid] = this.resource(id, 't');
    return this.connection(async client => {
      await this.open(client, folder);
      const uids = await this.threadUids(client, tid), messages = []; let bytes = 0;
      for (const uid of uids) {
        const { raw, row } = await this.download(client, uid, String(client.mailbox.uidValidity));
        bytes += raw.length; if (bytes > 24 * 1024 * 1024) throw new AppError('Thread exceeds the 24 MiB download limit.', 413);
        messages.push(await imapMessage(raw, row, `m-${pack([folder, String(client.mailbox.uidValidity), uid])}`, id));
      }
      return { id, messages: messages.sort((a, b) => a.date - b.date) };
    });
  }
  async raw(id) {
    const [folder, validity, uid] = this.resource(id, 'm');
    return this.connection(async client => { await this.open(client, folder, validity); return (await this.download(client, uid, validity)).raw; });
  }
  async attachment(id, attachmentId) {
    const parsed = await simpleParser(await this.raw(id), parseOptions);
    if (!/^\d+$/.test(attachmentId) || !parsed.attachments[Number(attachmentId)]) throw new AppError('Attachment not found.', 404);
    return parsed.attachments[Number(attachmentId)].content;
  }
  async modify(id, add, remove) {
    const [folder, tid] = this.resource(id, 't');
    return this.connection(async client => {
      const folders = await this.folders(client);
      await this.open(client, folder);
      const uids = await this.threadUids(client, tid);
      for (const [label, flag, inverted] of [['UNREAD', '\\Seen', true], ['STARRED', '\\Flagged', false]]) {
        if (add.includes(label)) await client[inverted ? 'messageFlagsRemove' : 'messageFlagsAdd'](uids, [flag], { uid: true });
        if (remove.includes(label)) await client[inverted ? 'messageFlagsAdd' : 'messageFlagsRemove'](uids, [flag], { uid: true });
      }
      if (add.includes('TRASH')) {
        if (!folders.trash) throw new AppError('Gmail Trash is not exposed over IMAP.', 502);
        await client.messageMove(uids, folders.trash, { uid: true });
      } else if (remove.includes('TRASH')) {
        if (folder !== folders.trash) throw new AppError('Refresh Trash before restoring this thread.', 409);
        if (!folders.all) throw new AppError('Gmail All Mail is not exposed over IMAP.', 502);
        await client.messageMove(uids, add.includes('INBOX') ? 'INBOX' : folders.all, { uid: true });
      } else {
        if (add.includes('INBOX')) await client.messageFlagsAdd(uids, ['\\Inbox'], { uid: true, useLabels: true });
        if (remove.includes('INBOX')) await client.messageFlagsRemove(uids, ['\\Inbox'], { uid: true, useLabels: true });
      }
      return { ok: true };
    });
  }
  async drafts({ pageToken = '' } = {}) {
    return this.connection(async client => {
      const folder = (await this.folders(client)).drafts;
      if (!folder) throw new AppError('Gmail Drafts is not exposed over IMAP.', 502);
      await this.open(client, folder);
      let before = Infinity;
      if (pageToken) {
        const values = unpack(pageToken);
        if (!Array.isArray(values) || values[0] !== folder || values[1] !== String(client.mailbox.uidValidity) || !Number.isSafeInteger(values[2])) throw new AppError('Draft pagination expired. Refresh the mailbox.', 409);
        before = values[2];
      }
      const uids = (await client.search({ all: true }, { uid: true })).filter(uid => uid < before).sort((a, b) => b - a);
      const selected = uids.slice(0, 30);
      return { drafts: selected.map(uid => ({ id: `m-${pack([folder, String(client.mailbox.uidValidity), uid])}` })), nextPageToken: uids.length > 30 ? pack([folder, String(client.mailbox.uidValidity), selected.at(-1)]) : '' };
    });
  }
  async draft(id) {
    const raw = await this.raw(id), message = await imapMessage(raw, { flags: new Set(['\\Seen']) }, id, '');
    return { ...message, bcc: decodeWords(headerValue(headers(raw), 'bcc')), hasAttachments: !!message.attachments.length };
  }
  async saveDraft(raw, threadId, id) {
    return this.connection(async client => {
      const folder = (await this.folders(client)).drafts;
      if (!folder) throw new AppError('Gmail Drafts is not exposed over IMAP.', 502);
      await this.open(client, folder);
      let old;
      if (id) {
        old = this.resource(id, 'm');
        if (old[0] !== folder || old[1] !== String(client.mailbox.uidValidity)) throw new AppError('Draft ID expired. Refresh before saving.', 409);
        const existing = await client.fetchOne(old[2], { uid: true }, { uid: true });
        if (!existing) throw new AppError('Draft no longer exists. Save a new draft.', 404);
      }
      const appended = await client.append(folder, raw, ['\\Draft', '\\Seen']);
      if (!appended?.uid || !appended.uidValidity) throw new AppError('Draft may have saved, but Gmail did not return its ID. Refresh Drafts before retrying.', 502);
      // Remove only the superseded draft, never a mailbox conversation.
      if (old) await client.messageDelete(old[2], { uid: true });
      return { id: `m-${pack([folder, String(appended.uidValidity), appended.uid])}` };
    });
  }
  async send(raw) {
    const h = headers(Buffer.from(raw));
    const to = [...addresses(headerValue(h, 'to')), ...addresses(headerValue(h, 'cc')), ...addresses(headerValue(h, 'bcc'))].map(a => a.email);
    // SMTP envelope contains Bcc; the delivered RFC822 message must not expose it.
    const separator = raw.indexOf('\r\n\r\n');
    if (separator < 0) throw new AppError('Mail must have RFC822 headers and a plain-text body.');
    const wire = raw.slice(0, separator).split(/\r\n(?=[^ \t])/).filter(field => !/^bcc:/i.test(field)).join('\r\n') + raw.slice(separator);
    const transport = this.transport(); let result;
    try { result = await transport.sendMail({ envelope: { from: addresses(headerValue(h, 'from'))[0].email, to }, raw: Buffer.from(wire) }); }
    catch { throw new AppError('SMTP send failed or its result is uncertain. Check Gmail Sent before sending again; Plainpost does not retry automatically.', 502); }
    finally { transport.close(); }
    if (result.rejected?.length) throw new AppError('Gmail rejected some recipients; others may have received the message. Check Sent before retrying.', 502);
    // Gmail records its own SMTP mail in Sent; appending would create duplicates.
    return { id: result.messageId, ok: true };
  }
  async sendDraft(id) {
    const [folder, validity, uid] = this.resource(id, 'm');
    const raw = await this.connection(async client => {
      if (folder !== (await this.folders(client)).drafts) throw new AppError('This resource is not a draft.');
      await this.open(client, folder, validity); return (await this.download(client, uid, validity)).raw;
    });
    const message = await imapMessage(raw, { flags: new Set() }, id, '');
    if (!message.hasPlainText || message.attachments.length || !/^text\/plain(?:;|$)/i.test(headerValue(headers(raw), 'content-type'))) throw new AppError('Only plain-text drafts without attachments can be sent here.');
    const result = await this.send(raw.toString('utf8'));
    try {
      await this.connection(async client => { await this.open(client, folder, validity); await client.messageDelete(uid, { uid: true }); });
    } catch { return { ...result, warning: 'Message sent, but its draft could not be removed. Refresh Sent; do not resend the draft.' }; }
    return result;
  }
}
