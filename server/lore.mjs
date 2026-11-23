import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { AppError, decodeWords, headerValue, toMbox } from './mail.mjs';

const MAX_DOWNLOAD = 8 * 1024 * 1024, MAX_MBOX = 24 * 1024 * 1024;
const digest = data => createHash('sha256').update(data).digest('hex').slice(0, 24);
const displayHeader = value => decodeWords(Buffer.from(value, 'latin1').toString('utf8'));

export function loreLink(value) {
  let url;
  try { url = new URL(value); } catch { throw new AppError('Paste a full https://lore.kernel.org/<list>/<message-id>/ link.'); }
  if (url.protocol !== 'https:' || url.hostname !== 'lore.kernel.org' || url.port || url.username || url.password) throw new AppError('Only HTTPS links on lore.kernel.org are supported.');
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length < 2 || !/^[a-zA-Z0-9_-]+$/.test(parts[0]) || parts.length > 3 || (parts[2] && !['t', 'T', 'raw', 't.mbox.gz'].includes(parts[2]))) throw new AppError('Use a lore message or thread link, rather than a list or search page.');
  let messageId;
  try { messageId = decodeURIComponent(parts[1]); } catch { throw new AppError('Invalid message ID in the lore link.'); }
  if (!messageId.includes('@') || /[\s<>\x00-\x1f\x7f]/.test(messageId) || messageId.length > 998) throw new AppError('Invalid message ID in the lore link.');
  const base = `https://lore.kernel.org/all/${encodeURIComponent(messageId)}/`;
  return { messageId: `<${messageId}>`, url: base, mboxUrl: `${base}t.mbox.gz` };
}

function entity(raw, depth = 0, budget = { parts: 0 }) {
  if (depth > 20 || ++budget.parts > 2000) throw new AppError('This thread has too many nested MIME parts.', 413);
  const split = raw.search(/\r?\n\r?\n/);
  if (split < 0) throw new AppError('The archive returned a malformed email.', 502);
  const separator = raw.slice(split).match(/^\r?\n\r?\n/)[0];
  const headers = raw.slice(0, split).replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/).map(line => {
    const colon = line.indexOf(':'); return { name: line.slice(0, colon), value: line.slice(colon + 1).trim() };
  }).filter(h => h.name && /^[\w-]+$/.test(h.name));
  const type = headerValue(headers, 'content-type') || 'text/plain', content = raw.slice(split + separator.length);
  const filename = /filename\s*=\s*(?:"([^"]*)"|([^;\s]+))/i.exec(headerValue(headers, 'content-disposition'));
  if (filename || /^attachment\b/i.test(headerValue(headers, 'content-disposition'))) return { headers, bodies: [], attachments: [{ name: decodeWords(filename?.[1] || filename?.[2] || 'attachment'), size: Buffer.byteLength(content, 'latin1') }] };
  if (/^multipart\//i.test(type)) {
    const boundary = /boundary\s*=\s*(?:"([^"]+)"|([^;\s]+))/i.exec(type);
    if (!boundary) throw new AppError('The archive returned a multipart email without a boundary.', 502);
    const marker = boundary[1] || boundary[2], parts = []; let lines = null;
    for (const line of content.split('\n')) {
      const trimmed = line.replace(/\r$/, '').replace(/[ \t]+$/, '');
      if (trimmed === `--${marker}` || trimmed === `--${marker}--`) {
        if (lines) parts.push(entity(lines.join('\n'), depth + 1, budget));
        lines = trimmed.endsWith('--') ? null : [];
        if (trimmed === `--${marker}--`) break;
      } else if (lines) lines.push(line);
    }
    return { headers, bodies: parts.flatMap(p => p.bodies), attachments: parts.flatMap(p => p.attachments) };
  }
  if (!/^text\/plain(?:\s*;|\s*$)/i.test(type)) return { headers, bodies: [], attachments: [] };
  const encoding = headerValue(headers, 'content-transfer-encoding').toLowerCase();
  const bytes = encoding === 'base64' ? Buffer.from(content.replace(/\s/g, ''), 'base64') : Buffer.from(encoding === 'quoted-printable' ? content.replace(/=\r?\n/g, '').replace(/=([a-f\d]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16))) : content, 'latin1');
  const charset = /charset\s*=\s*"?([^;"\s]+)/i.exec(type)?.[1] || 'utf-8';
  let text; try { text = new TextDecoder(charset).decode(bytes); } catch { text = bytes.toString('utf8'); }
  return { headers, bodies: [text], attachments: [] };
}

// Shared with the IMAP reader: detect actual text/plain parts, including empty ones.
export function plainMime(source) { return entity(source.toString('latin1')); }

export function parseLoreMbox(buffer, source) {
  if (buffer.length > MAX_MBOX) throw new AppError('Thread exceeds the 24 MiB expanded limit.', 413);
  const text = buffer.toString('latin1');
  if (!/^From [^\n]+\n/.test(text)) throw new AppError('Lore returned a page instead of a thread mailbox. The archive may be temporarily unavailable or require browser access.', 502);
  const raws = text.split(/^From [^\n]*\n/gm).slice(1).map(raw => Buffer.from(raw.replace(/^>(>*From )/gm, '$1').replace(/\n$/, ''), 'latin1'));
  if (!raws.length || raws.length > 1000) throw new AppError('Thread must contain between 1 and 1,000 messages.', 413);
  const threadId = `lore-${digest(source.url)}`, rawMap = new Map();
  const messages = raws.map(raw => {
    const parsed = entity(raw.toString('latin1')), h = name => headerValue(parsed.headers, name), id = `lore-${digest(raw)}`;
    if (!h('message-id') || !h('from')) throw new AppError('Lore returned an email without required headers.', 502);
    rawMap.set(id, raw);
    return { id, threadId: '', messageId: h('message-id'), inReplyTo: h('in-reply-to'), references: h('references'), from: displayHeader(h('from')), to: displayHeader(h('to')), cc: displayHeader(h('cc')), replyTo: displayHeader(h('reply-to')), subject: displayHeader(h('subject')), date: Date.parse(h('date')) || 0, listId: h('list-id'), listPost: h('list-post'), body: parsed.bodies.join('\n'), hasPlainText: !!parsed.bodies.length, attachments: parsed.attachments, labelIds: [], sourceUrl: `https://lore.kernel.org/all/${encodeURIComponent(h('message-id').replace(/^<|>$/g, ''))}/` };
  }).filter((message, i, all) => all.findIndex(m => m.messageId === message.messageId) === i).sort((a, b) => a.date - b.date);
  return { thread: { id: threadId, source: 'lore', sourceUrl: source.url, requestedMessageId: source.messageId, messages }, rawMap, mbox: toMbox([...rawMap.values()]) };
}

export async function fetchLore(value, fetcher = fetch) {
  const source = loreLink(value), controller = new AbortController(), timer = setTimeout(() => controller.abort(), 30000);
  try {
    let url = source.mboxUrl, response;
    for (let hop = 0; hop < 5; hop++) {
      response = await fetcher(url, { signal: controller.signal, redirect: 'manual', headers: { Accept: 'application/gzip, application/mbox, application/octet-stream', 'User-Agent': 'Plainpost/1.0 (local plain-text mail reader)' } });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      const next = new URL(response.headers.get('location') || '', url);
      loreLink(next.href); // Reject off-host redirects before making another request.
      if (!next.pathname.endsWith('/t.mbox.gz')) throw new AppError('Lore redirected away from the mailbox download.', 502);
      await response.body?.cancel(); url = next.href; response = null;
    }
    if (!response?.ok) throw new AppError(`Lore could not provide this thread (${response?.status || 'redirect loop'}). Check the link or try again later.`, 502);
    const chunks = []; let size = 0;
    for await (const chunk of response.body) { size += chunk.length; if (size > MAX_DOWNLOAD) { controller.abort(); throw new AppError('Thread download exceeds 8 MiB.', 413); } chunks.push(chunk); }
    let buffer = Buffer.concat(chunks);
    if (buffer[0] === 0x1f && buffer[1] === 0x8b) {
      try { buffer = gunzipSync(buffer, { maxOutputLength: MAX_MBOX }); } catch { throw new AppError('Invalid gzip archive or thread exceeds the 24 MiB expanded limit.', 413); }
    }
    return parseLoreMbox(buffer, source);
  } catch (error) { if (error.status) throw error; throw new AppError('Could not reach lore.kernel.org. Check the network connection and try again.', 502); }
  finally { clearTimeout(timer); }
}
