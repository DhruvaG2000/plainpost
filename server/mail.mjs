import { randomUUID } from 'node:crypto';

export class AppError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

export function headerValue(headers = [], name) {
  return headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || '';
}

export function decodeWords(value) {
  return value.replace(/(\?=)\s+(=\?)/g, '$1$2').replace(/=\?([^?]+)\?([bq])\?([^?]*)\?=/gi, (all, charset, encoding, text) => {
    try {
      const bytes = encoding.toLowerCase() === 'b' ? Buffer.from(text, 'base64') : Buffer.from(text.replace(/_/g, ' ').replace(/=([0-9a-f]{2})/gi, (_, x) => String.fromCharCode(parseInt(x, 16))), 'latin1');
      return new TextDecoder(charset).decode(bytes);
    } catch { return all; }
  });
}

export function addresses(value = '') {
  if (typeof value !== 'string' || /[\r\n\x00]/.test(value)) throw new AppError('Address headers cannot contain newlines.');
  const tokens = []; let current = '', quoted = false, escape = false;
  for (const ch of value) {
    if (ch === '"' && !escape) quoted = !quoted;
    if (ch === ',' && !quoted) { tokens.push(current); current = ''; } else current += ch;
    escape = ch === '\\' && !escape;
  }
  tokens.push(current);
  return tokens.filter(t => t.trim()).map(token => {
    const match = token.trim().match(/^(?:(.*?)\s*<([^<>]+)>|([^<>\s]+))$/);
    if (!match) throw new AppError(`Invalid email address: ${token.trim()}`);
    const email = (match[2] || match[3]).trim();
    if (!/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,}$/.test(email) || email.length > 254) throw new AppError(`Invalid email address: ${email}`);
    return { name: (match[1] || '').trim().replace(/^"|"$/g, ''), email };
  });
}

function encodedWord(text) {
  if (/^[\x20-\x7e]*$/.test(text)) return text;
  const words = []; let chunk = '';
  for (const char of text) {
    if (Buffer.byteLength(chunk + char) > 42) { words.push(`=?UTF-8?B?${Buffer.from(chunk).toString('base64')}?=`); chunk = ''; }
    chunk += char;
  }
  if (chunk) words.push(`=?UTF-8?B?${Buffer.from(chunk).toString('base64')}?=`);
  return words.join('\r\n ');
}

function addressHeader(mailboxes) {
  return mailboxes.map(({ name, email }) => name ? `${/^[\x20-\x7e]*$/.test(name) ? '"' + name.replace(/["\\]/g, '\\$&') + '"' : encodedWord(name)} <${email}>` : email).join(',\r\n ');
}

export function messageIds(value = '') {
  return String(value).match(/<[^<>\s\x00-\x1f]+@[^<>\s\x00-\x1f]+>/g) || [];
}

export function buildRawMail(input, from, now = new Date(), { messageId, extraHeaders = [], uniqueRecipients = false } = {}) {
  if (!input || typeof input !== 'object') throw new AppError('Message is required.');
  for (const field of ['to', 'cc', 'bcc', 'subject', 'body']) {
    if (input[field] !== undefined && typeof input[field] !== 'string') throw new AppError(`${field} must be text.`);
  }
  let to = addresses(input.to);
  let cc = addresses(input.cc);
  if (uniqueRecipients) {
    const seen = new Set();
    const firstOccurrence = ({ email }) => {
      const key = email.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    };
    to = to.filter(firstOccurrence);
    cc = cc.filter(firstOccurrence);
  }
  if (!to.length) throw new AppError('Enter at least one To address.');
  const subject = input.subject || '';
  if (!subject.trim() || /[\r\n\x00-\x1f\x7f]/.test(subject) || Buffer.byteLength(subject) > 900) throw new AppError('Enter a subject without control characters (maximum 900 bytes).');
  if (typeof input.body !== 'string' || !input.body.trim()) throw new AppError('The plain-text body is empty.');
  if (Buffer.byteLength(input.body) > 2 * 1024 * 1024 || input.body.includes('\0')) throw new AppError('Message body must be valid text under 2 MiB.');
  const body = input.body.replace(/\r\n|\r|\n/g, '\r\n');
  if (body.split('\r\n').some(line => Buffer.byteLength(line) > 998)) throw new AppError('A body line exceeds 998 bytes. Shorten it manually; patches are never automatically wrapped.');
  const senders = addresses(from);
  const fromEmail = senders[0]?.email;
  if (!fromEmail) throw new AppError('Account email is missing.');
  if (messageId && messageIds(messageId)[0] !== messageId) throw new AppError('Invalid Message-ID.');
  const headers = [
    `From: ${addressHeader(senders)}`, `To: ${addressHeader(to)}`,
    ...(cc.length ? [`Cc: ${addressHeader(cc)}`] : []),
    ...(input.bcc ? [`Bcc: ${addressHeader(addresses(input.bcc))}`] : []),
    `Subject: ${encodedWord(subject)}`, `Date: ${now.toUTCString()}`,
    `Message-ID: ${messageId || `<${randomUUID()}@${fromEmail.split('@')[1]}>`}`,
    'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit', 'X-Mailer: Plainpost/1.0'
  ];
  if (input.inReplyTo) {
    const parent = messageIds(input.inReplyTo)[0];
    if (!parent || parent !== input.inReplyTo) throw new AppError('Invalid reply Message-ID.');
    headers.push(`In-Reply-To: ${parent}`);
    const refs = [...new Set([...messageIds(input.references).slice(-20), parent])];
    headers.push(`References: ${refs.join('\r\n ')}`);
  }
  for (const { name, value } of extraHeaders) {
    if (!/^[A-Za-z0-9-]+$/.test(name) || !/^[\x20-\x7e]+$/.test(value)) throw new AppError('Invalid patch metadata header.');
    let header = name + ':';
    let column = header.length;
    for (const word of value.trim().split(/ +/)) {
      const separator = column + word.length + 1 > 78 ? '\r\n ' : ' ';
      header += separator + word;
      column = (separator.length > 1 ? 0 : column) + word.length + 1;
    }
    headers.push(header);
  }
  if (headers.some(h => h.split('\r\n').some(l => Buffer.byteLength(l) > 998))) throw new AppError('An email header is too long.');
  return headers.join('\r\n') + '\r\n\r\n' + body + (body.endsWith('\r\n') ? '' : '\r\n');
}

export function plainParts(payload) {
  const output = [];
  function walk(part) {
    if (part.mimeType === 'text/plain' && !part.filename) output.push(part);
    for (const child of part.parts || []) walk(child);
  }
  walk(payload || {});
  return output;
}

export function decodePart(part, data) {
  const contentType = headerValue(part.headers, 'content-type');
  const charset = contentType.match(/charset\s*=\s*"?([^;"\s]+)/i)?.[1] || 'utf-8';
  try { return new TextDecoder(charset).decode(Buffer.from(data || '', 'base64url')); }
  catch { return Buffer.from(data || '', 'base64url').toString('utf8'); }
}

export function messageSummary(message) {
  const headers = message.payload?.headers || [];
  return {
    id: message.id, threadId: message.threadId, labelIds: message.labelIds || [],
    from: decodeWords(headerValue(headers, 'from')), to: decodeWords(headerValue(headers, 'to')),
    cc: decodeWords(headerValue(headers, 'cc')), replyTo: decodeWords(headerValue(headers, 'reply-to')),
    subject: decodeWords(headerValue(headers, 'subject')), date: Number(message.internalDate) || Date.parse(headerValue(headers, 'date')) || 0,
    messageId: headerValue(headers, 'message-id'), inReplyTo: headerValue(headers, 'in-reply-to'), references: headerValue(headers, 'references'),
    listId: headerValue(headers, 'list-id'), listPost: headerValue(headers, 'list-post'),
    snippet: decodeWords(message.snippet || ''),
    attachments: collectAttachments(message.payload)
  };
}

function collectAttachments(payload) {
  const result = [];
  function walk(part) {
    if (part?.filename && part?.body?.attachmentId) result.push({ name: part.filename, id: part.body.attachmentId, mimeType: part.mimeType, size: part.body.size || 0 });
    for (const child of part?.parts || []) walk(child);
  }
  walk(payload); return result;
}

export function summarizeThread(thread) {
  const messages = (thread.messages || []).map(messageSummary);
  const latest = messages.at(-1) || {};
  const first = messages[0] || {};
  return { id: thread.id, subject: first.subject || '(no subject)', from: latest.from || '', date: latest.date || 0, count: messages.length, snippet: latest.snippet || '', listId: first.listId || latest.listId || '', unread: messages.some(m => m.labelIds.includes('UNREAD')), starred: messages.some(m => m.labelIds.includes('STARRED')), labels: [...new Set(messages.flatMap(m => m.labelIds))] };
}

export function toMbox(raws) {
  return Buffer.from(raws.map(raw => `From plainpost@localhost Thu Jan 01 00:00:00 1970\n${(Buffer.isBuffer(raw) ? raw.toString('latin1') : Buffer.from(raw).toString('latin1')).replace(/\r\n/g, '\n').replace(/^(>*From )/gm, '>$1').replace(/\n?$/, '\n')}\n`).join(''), 'latin1');
}
