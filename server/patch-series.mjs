import { constants } from 'node:fs';
import { open, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, extname, isAbsolute, join } from 'node:path';
import { addresses, AppError, buildRawMail, decodeWords, headerValue, messageIds } from './mail.mjs';
import { plainMime } from './lore.mjs';

export const MAX_SERIES_BYTES = 8 * 1024 * 1024;
const MAX_MESSAGES = 100;
const patchFile = /\.(?:patch|diff|eml|mbox|mbx)$/i;
const gitEnvelope = /^From [a-f0-9]{40,64} Mon Sep 17 00:00:00 2001\r?\n/;
const gitEnvelopes = new RegExp(gitEnvelope.source, 'gm');
const patchBody = /^diff --git |^--- .+\n\+\+\+ /m;
const utf8 = new TextDecoder('utf-8', { fatal: true });

async function readPatch(path, remaining) {
  // Nonblocking open prevents a supplied FIFO from stalling the local server.
  const file = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK || 0));
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new AppError('Choose a regular patch file or a directory of patches.');
    if (info.size > remaining) throw new AppError('The series exceeds 8 MiB.');
    const buffer = Buffer.alloc(info.size + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const result = await file.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (!result.bytesRead) break;
      bytesRead += result.bytesRead;
    }
    if (bytesRead !== info.size) throw new AppError('A patch file changed while being read. Load it again.');
    if (buffer.subarray(0, bytesRead).includes(0)) throw new AppError('Patch files must be text.');
    try { return { source: utf8.decode(buffer.subarray(0, bytesRead)), size: bytesRead }; }
    catch { throw new AppError('Patch files must be UTF-8 or use an ASCII MIME transfer encoding.'); }
  } finally {
    await file.close();
  }
}

function seriesSequence(subject) {
  const order = subject.match(/^((?:\[[^\]\n]+\]\s*)*?\[[^\]\n]*?)\b(\d+)\/(\d+)\s*\]/);
  return order ? { number: Number(order[2]), total: Number(order[3]), prefix: order[1].trim() } : null;
}

function parsePatch(source, filename) {
  const normalized = source.replace(/\r\n|\r/g, '\n').replace(gitEnvelope, '');
  const boundary = normalized.indexOf('\n\n');
  const headerText = boundary >= 0 ? normalized.slice(0, boundary) : '';
  const headers = headerText.replace(/\n[ \t]+/g, ' ').split('\n').flatMap(line => {
    const match = line.match(/^([\w-]+):[ \t]*(.*)$/);
    return match ? [{ name: match[1], value: match[2] }] : [];
  });
  const get = name => headerValue(headers, name);
  const subject = decodeWords(get('subject'));
  if (!subject && patchBody.test(normalized)) {
    return { subject: '[PATCH] ' + basename(filename, extname(filename)), body: normalized, to: '', cc: '', author: '', filename };
  }
  if (!subject || boundary < 0) throw new AppError('Patch email is missing its Subject header or body.');
  if (get('bcc')) throw new AppError('Remove Bcc from patch emails before using the relay.');
  const mime = plainMime(Buffer.from(normalized));
  if (mime.attachments.length || mime.bodies.length !== 1) throw new AppError('Use a single inline text/plain patch or cover letter.');
  const body = mime.bodies[0].replace(/\r\n|\r/g, '\n');
  const sequence = seriesSequence(subject);
  if (!patchBody.test(body) && sequence?.number !== 0) throw new AppError('No inline diff found in the patch email.');
  const tracking = ['X-B4-Tracking', 'X-Change-ID'].flatMap(name => get(name) ? [{ name, value: get(name) }] : []);
  return { subject, body, to: get('to'), cc: get('cc'), author: get('from'), filename, sequence, tracking,
    messageId: get('message-id'), inReplyTo: get('in-reply-to'), references: get('references') };
}

function orderedSeries(messages) {
  if (!messages.some(message => message.sequence)) {
    if (messages.length !== 1) throw new AppError('Use numbered patch subjects for a series.');
    return messages;
  }
  if (messages.some(message => !message.sequence)) throw new AppError('Every message needs a series number in its subject.');
  const [{ sequence: first }] = messages;
  if (!first.total || first.total > MAX_MESSAGES || messages.some(({ sequence }) => sequence.total !== first.total || sequence.prefix !== first.prefix)) {
    throw new AppError('Choose patch files from a single revision of the series.');
  }
  const sorted = [...messages].sort((a, b) => a.sequence.number - b.sequence.number);
  const cover = sorted[0].sequence.number === 0;
  if (sorted.length !== first.total + Number(cover) || sorted.some(({ sequence }, i) => sequence.number !== i + Number(!cover))) {
    throw new AppError('The series has missing or duplicate patch numbers.');
  }
  return sorted;
}

export async function loadPatchSeries(value) {
  const path = typeof value === 'string' && value.startsWith('~/') ? join(homedir(), value.slice(2)) : value;
  if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0')) throw new AppError('Enter an absolute path on the Plainpost host.');
  try {
    let paths;
    try {
      const entries = await readdir(path, { withFileTypes: true });
      paths = entries.filter(entry => entry.isFile() && patchFile.test(entry.name)).map(entry => join(path, entry.name));
    } catch (error) {
      if (error.code !== 'ENOTDIR') throw error;
      paths = [path];
    }
    if (!paths.length) throw new AppError('No patch files found in this directory.');
    if (paths.length > MAX_MESSAGES) throw new AppError('A series can contain up to 100 messages.');

    const messages = [];
    let remaining = MAX_SERIES_BYTES;
    for (const path of paths) {
      const filename = basename(path);
      const { source, size } = await readPatch(path, remaining);
      remaining -= size;
      const starts = [...source.matchAll(gitEnvelopes)].map(match => match.index);
      const chunks = starts.length && starts[0] === 0 ? starts.map((start, i) => source.slice(start, starts[i + 1])) : [source];
      if (messages.length + chunks.length > MAX_MESSAGES) throw new AppError('A series can contain up to 100 messages.');
      for (const chunk of chunks) {
        try { messages.push(parsePatch(chunk, filename)); }
        catch (error) {
          if (!(error instanceof AppError)) throw error;
          throw new AppError(`${filename}: ${error.message}`);
        }
      }
    }
    return orderedSeries(messages);
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('Could not read that path. Check that it exists on the Plainpost host and is readable.');
  }
}

export function buildPatchSeries(sources, edits, from) {
  if (!Array.isArray(edits) || edits.length !== sources.length) throw new AppError('Review every message in the loaded series.');
  const fromEmail = addresses(from)[0].email.toLowerCase();
  const rows = [];
  const now = new Date();
  let bytes = 0;
  for (const [i, source] of sources.entries()) {
    const edit = edits[i];
    if (!edit || ['to', 'cc', 'subject', 'body'].some(field => typeof edit[field] !== 'string')) {
      throw new AppError('Each draft requires text recipients, subject, and body.');
    }
    const order = seriesSequence(edit.subject);
    if (source.sequence && (order?.number !== source.sequence.number || order.total !== source.sequence.total)) {
      throw new AppError(`Keep the series number in the subject of message ${i + 1}.`);
    }
    if (source.sequence?.number !== 0 && !patchBody.test(edit.body)) throw new AppError(`Message ${i + 1} is missing its inline diff.`);
    const root = rows[0]?.messageId;
    const messageId = source.messageId;
    if (messageId && rows.some(row => row.messageId === messageId)) throw new AppError('Patch emails have duplicate Message-IDs.');
    const author = source.author ? addresses(source.author)[0] : null;
    const body = author && author.email.toLowerCase() !== fromEmail && !/^From: /i.test(edit.body)
      ? `From: ${decodeWords(source.author)}\n\n${edit.body}` : edit.body;
    const inReplyTo = source.inReplyTo || (i ? root : '');
    const references = source.references || (i ? root : '');
    let raw;
    try {
      raw = buildRawMail({ to: edit.to, cc: edit.cc, subject: edit.subject, body, inReplyTo, references }, from, now,
        { messageId, extraHeaders: source.tracking, uniqueRecipients: true }).replaceAll('\r\n', '\n');
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      throw new AppError(`Message ${i + 1} (${source.filename}): ${error.message}`);
    }
    bytes += Buffer.byteLength(raw);
    if (bytes > MAX_SERIES_BYTES) throw new AppError('The reviewed series exceeds 8 MiB.');
    const header = raw.slice(0, raw.indexOf('\n\n'));
    rows.push({ filename: source.filename, subject: edit.subject, raw,
      messageId: messageIds(header.match(/^Message-ID: (.*)$/m)?.[1])[0] });
  }
  return rows;
}
