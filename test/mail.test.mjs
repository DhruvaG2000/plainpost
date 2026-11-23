import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRawMail, addresses, decodeWords, plainParts, decodePart, toMbox, summarizeThread } from '../server/mail.mjs';
import { extractPatch, replyFields, insertSignoff } from '../public/compose.js';

const base = { to: 'linux-kernel@vger.kernel.org', subject: '[PATCH] sched: example', body: 'diff --git a/a.c b/a.c\n+\treturn 0;  \n\n-- \n2.47.0\n' };

test('outbound mail is only text/plain and preserves patch tabs, trailing spaces and line breaks', () => {
  const raw = buildRawMail(base, 'developer@gmail.com');
  assert.match(raw, /Content-Type: text\/plain; charset=UTF-8/);
  assert.match(raw, /Content-Transfer-Encoding: 8bit/);
  assert.doesNotMatch(raw, /text\/html|format=flowed|multipart\//);
  assert.equal(raw.slice(raw.indexOf('\r\n\r\n') + 4), base.body.replace(/\n/g, '\r\n'));
  assert.equal(raw.replace(/\r\n/g, '').includes('\n'), false);
});
test('outbound replies retain In-Reply-To and References, without header injection', () => {
  const raw = buildRawMail({ ...base, inReplyTo: '<parent@kernel.org>', references: '<first@kernel.org>\nBcc: stolen@example.org\n<parent@kernel.org>' }, 'developer@gmail.com');
  assert.match(raw, /In-Reply-To: <parent@kernel.org>/);
  assert.match(raw, /References: <first@kernel.org>\r\n <parent@kernel.org>/);
  assert.doesNotMatch(raw, /stolen@example/);
  assert.throws(() => buildRawMail({ ...base, inReplyTo: '<parent@kernel.org>\r\nBcc: stolen@example.org' }, 'developer@gmail.com'), /Invalid reply/);
});
test('UTF-8 subjects are encoded in bounded words, preserving Unicode boundaries', () => {
  const subject = 'Révision 日本語 🐧 '.repeat(18);
  const raw = buildRawMail({ ...base, subject }, 'Développeur <developer@gmail.com>');
  const value = raw.match(/^Subject: (.*(?:\r\n .*)*)\r\nDate:/m)[1];
  assert.equal(decodeWords(value), subject);
  for (const word of value.split(/\s+/)) assert.ok(word.length <= 75);
});
test('address lists support quoted commas and reject unsafe address headers', () => {
  assert.deepEqual(addresses('"Developer, A" <dev@example.org>, reviewer@kernel.org').map(a => a.email), ['dev@example.org', 'reviewer@kernel.org']);
  for (const to of ['dev@example.org\r\nBcc: bad@example.org', 'not an address', 'dev@example.org\0']) assert.throws(() => buildRawMail({ ...base, to }, 'developer@gmail.com'));
  assert.throws(() => buildRawMail({ ...base, subject: 'Hi\r\nBcc: evil@example.org' }, 'developer@gmail.com'));
});
test('long patch lines are rejected, not wrapped or trimmed', () => {
  assert.throws(() => buildRawMail({ ...base, body: '\t' + 'x'.repeat(998) }, 'developer@gmail.com'), /998 bytes/);
  assert.throws(() => buildRawMail({ ...base, body: 'é'.repeat(500) }, 'developer@gmail.com'), /998 bytes/);
  assert.throws(() => buildRawMail({ ...base, body: ' ' }, 'developer@gmail.com'), /empty/);
});
test('MIME traversal picks plain text and excludes HTML and text attachments', () => {
  const payload = { mimeType: 'multipart/mixed', parts: [{ mimeType: 'multipart/alternative', parts: [{ mimeType: 'text/html', body: { data: 'bad' } }, { mimeType: 'text/plain', headers: [{ name: 'Content-Type', value: 'text/plain; charset=iso-8859-1' }], body: { data: Buffer.from([0x63, 0x61, 0x66, 0xe9]).toString('base64url') } }] }, { mimeType: 'text/plain', filename: 'attached.txt' }] };
  const parts = plainParts(payload);
  assert.equal(parts.length, 1); assert.equal(decodePart(parts[0], parts[0].body.data), 'café');
  assert.equal(plainParts({ mimeType: 'text/html' }).length, 0);
});
test('mbox exports protect From delimiters and preserve original 8-bit bytes', () => {
  const raw = Buffer.concat([Buffer.from('Subject: test\r\n\r\nFrom line\r\n>From quoted\r\ncaf'), Buffer.from([0xe9]), Buffer.from('\r\n')]);
  const mbox = toMbox([raw]).toString('latin1');
  assert.match(mbox, /^From plainpost@localhost /); assert.match(mbox, /\n>From line\n>>From quoted\ncafé\n/);
});
test('inline patch import strips format-patch headers without modifying content', () => {
  const body = 'Commit description\n\nSigned-off-by: Developer <dev@example.org>\n---\n+\tspace  \n';
  const input = `From ${'a'.repeat(40)} Mon Sep 17 00:00:00 2001\nFrom: Developer <dev@example.org>\nDate: Thu, 1 Jan 1970 00:00:00 +0000\nSubject: [PATCH v2]\n sched: example\n\n${body}`;
  assert.deepEqual(extractPatch(input), { subject: '[PATCH v2] sched: example', body });
  assert.throws(() => extractPatch('From: a@example.org\nContent-Type: text/html\n\n<b>bad</b>'), /text\/plain/);
  assert.equal(extractPatch('+\tline  \n').body, '+\tline  \n');
});
test('reply all deduplicates recipients, excludes the account, quotes verbatim, and places cursor after quote', () => {
  const fields = replyFields({ from: 'Author <author@example.org>', replyTo: '', to: 'you@gmail.com, list@kernel.org', cc: 'Reviewer <reviewer@example.org>, list@kernel.org', listPost: '<mailto:list@kernel.org>', subject: '[PATCH] test', body: 'line\n\tindent  \n', date: 0, messageId: '<id@kernel.org>', threadId: 'abc', references: '<old@kernel.org>' }, 'you@gmail.com', true);
  assert.equal(fields.to, 'author@example.org'); assert.equal(fields.cc, 'list@kernel.org, reviewer@example.org');
  assert.ok(fields.body.includes('> \tindent  ')); assert.ok(fields.body.endsWith('\n\n'));
  assert.equal(fields.inReplyTo, '<id@kernel.org>'); assert.equal(fields.subject, 'Re: [PATCH] test');
});
test('thread metadata flags reflect all messages, rather than just the latest', () => {
  const thread = summarizeThread({ id: 't', messages: [{ id: 'm1', labelIds: ['UNREAD'], payload: { headers: [{ name: 'Subject', value: '[PATCH] test' }] }, internalDate: '1' }, { id: 'm2', labelIds: ['STARRED'], payload: { headers: [{ name: 'Subject', value: 'Re: [PATCH] test' }] }, internalDate: '2' }] });
  assert.equal(thread.unread, true); assert.equal(thread.starred, true); assert.equal(thread.subject, '[PATCH] test'); assert.equal(thread.count, 2);
});

test('sign-off inserts before the patch separator, preserving diff and spacing', () => {
  const diff = '---\n file.c | 1 +\n\ndiff --git a/file.c b/file.c\n+\tline  \n';
  const body = insertSignoff('Commit description\n\n' + diff, 'Signed-off-by: Developer <dev@example.org>');
  assert.equal(body, 'Commit description\n\nSigned-off-by: Developer <dev@example.org>\n' + diff);
});
