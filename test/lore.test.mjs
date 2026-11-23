import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { loreLink, parseLoreMbox, fetchLore } from '../server/lore.mjs';
import { toMbox, buildRawMail } from '../server/mail.mjs';
import { threadTree } from '../public/threading.js';
import { replyFields } from '../public/compose.js';

const root = Buffer.from('From: Author <author@example.org>\nTo: linux-kernel@vger.kernel.org\nSubject: [PATCH] example\nDate: Fri, 02 Oct 2026 10:00:00 +0000\nMessage-ID: <root@example.org>\nList-Post: <mailto:linux-kernel@vger.kernel.org>\nContent-Type: text/plain; charset=UTF-8\n\n+\tpatch line  \nFrom preserved body\n>From quoted body\n');
const child = Buffer.from('From: Reviewer <reviewer@example.org>\nTo: author@example.org\nSubject: Re: [PATCH] example\nDate: Fri, 02 Oct 2026 10:05:00 +0000\nMessage-ID: <child@example.org>\nList-Post: <mailto:linux-kernel@vger.kernel.org>\nIn-Reply-To: <root@example.org>\nReferences: <root@example.org>\nContent-Type: multipart/alternative; boundary="mime-part"\n\n--mime-part\nContent-Type: text/html\n\n<script>never displayed</script>\n--mime-part\nContent-Type: text/plain; charset=UTF-8\nContent-Transfer-Encoding: quoted-printable\n\n> + patch line=20=20\nPlease explain this.=0A\n--mime-part--\n');
const mailbox = toMbox([root, child]);
const url = 'https://lore.kernel.org/lkml/root@example.org/T/#u';

test('lore accepts message, thread, escaped IDs and r links; rejects SSRF targets and search pages', () => {
  for (const path of ['all/root@example.org/', 'lkml/root@example.org/T/#u', 'r/root@example.org', 'all/a%2Fb%40example.org/t.mbox.gz']) assert.match(loreLink(`https://lore.kernel.org/${path}`).mboxUrl, /^https:\/\/lore\.kernel\.org\/all\/.+\/t\.mbox\.gz$/);
  for (const value of ['http://lore.kernel.org/all/root@example.org/', 'https://lore.kernel.org.evil.test/all/root@example.org/', 'https://localhost/all/root@example.org/', 'https://user@lore.kernel.org/all/root@example.org/', 'https://lore.kernel.org:444/all/root@example.org/', 'https://lore.kernel.org/lkml/?q=foo', 'https://lore.kernel.org/all/%0aroot@example.org/']) assert.throws(() => loreLink(value));
});
test('mbox parser preserves patch bytes and mboxrd escaping, decodes MIME plain text and excludes HTML', () => {
  const parsed = parseLoreMbox(mailbox, loreLink(url));
  assert.equal(parsed.thread.messages.length, 2);
  assert.equal(parsed.thread.messages[0].body, '+\tpatch line  \nFrom preserved body\n>From quoted body\n');
  assert.equal(parsed.thread.messages[1].body, '> + patch line  \nPlease explain this.\n');
  assert.equal(parsed.thread.messages[1].inReplyTo, '<root@example.org>');
  assert.deepEqual(parsed.rawMap.get(parsed.thread.messages[0].id), root);
  const reply = replyFields(parsed.thread.messages[1], 'me@gmail.com', true);
  assert.equal(reply.threadId, ''); assert.equal(reply.inReplyTo, '<child@example.org>'); assert.match(buildRawMail({ ...reply, body: 'Thanks.\n' }, 'me@gmail.com'), /References: <root@example.org>\r\n <child@example.org>/);
  assert.match(reply.cc, /linux-kernel@vger.kernel.org/);
});
test('archive MIME handles UTF-8 headers, base64 bodies, attachments and HTML-only mail', () => {
  const raw = Buffer.from('From: José <jose@example.org>\nSubject: =?UTF-8?B?w6l4YW1wbGU=?=\nMessage-ID: <mime@example.org>\nContent-Type: multipart/mixed; boundary="b"\n\n--b\nContent-Type: text/plain; charset=UTF-8\nContent-Transfer-Encoding: base64\n\n' + Buffer.from('é\n+\tpatch  \n').toString('base64') + '\n--b\nContent-Type: text/plain\nContent-Disposition: attachment; filename="patch.txt"\n\nAttachment only\n--b--\n');
  const html = Buffer.from('From: A <a@example.org>\nMessage-ID: <html@example.org>\nContent-Type: text/html\n\n<img src="https://evil.test/tracker"><script>alert(1)</script>\n');
  const messages = parseLoreMbox(toMbox([raw, html]), loreLink(url)).thread.messages;
  assert.equal(messages[0].from, 'José <jose@example.org>'); assert.equal(messages[0].subject, 'éxample');
  assert.equal(messages[0].body, 'é\n+\tpatch  \n'); assert.equal(messages[0].attachments[0].name, 'patch.txt');
  assert.equal(messages[1].hasPlainText, false); assert.equal(messages[1].body, '');
});

test('lore downloads gzip, validates redirects before requests, and reports HTML/error responses', async () => {
  const calls = [];
  const parsed = await fetchLore(url, async (target, options) => { calls.push(target); assert.equal(options.redirect, 'manual'); return new Response(gzipSync(mailbox)); });
  assert.equal(parsed.thread.source, 'lore'); assert.equal(calls.length, 1);
  assert.equal(calls[0], 'https://lore.kernel.org/all/root%40example.org/t.mbox.gz');
  let redirects = 0;
  await assert.rejects(() => fetchLore(url, async () => { redirects++; return new Response(null, { status: 302, headers: { location: 'https://127.0.0.1/private' } }); }), /Only HTTPS links/);
  assert.equal(redirects, 1);
  await assert.rejects(() => fetchLore(url, async () => new Response('<html>challenge</html>')), /page instead/);
  await assert.rejects(() => fetchLore(url, async () => new Response('', { status: 404 })), /404/);
  await assert.rejects(() => fetchLore(url, async () => new Response(Buffer.alloc(8 * 1024 * 1024 + 1))), /8 MiB/);
  await assert.rejects(() => fetchLore(url, async () => new Response(gzipSync(Buffer.alloc(24 * 1024 * 1024 + 1)))), /expanded limit/);
});
test('thread tree follows headers despite date order and handles siblings, missing ancestors and cycles', () => {
  const messages = [{ id: 'c', messageId: '<c@x>', inReplyTo: '<b@x>', date: 1 }, { id: 'a', messageId: '<a@x>', date: 4 }, { id: 'b', messageId: '<b@x>', inReplyTo: '<a@x>', date: 3 }, { id: 'd', messageId: '<d@x>', references: '<a@x>', date: 5 }];
  const rows = threadTree(messages); assert.deepEqual(rows.map(r => r.node.message.id), ['a', 'b', 'c', 'd']); assert.deepEqual(rows.map(r => r.depth), [0, 1, 2, 1]);
  const missing = threadTree([{ id: 'm', messageId: '<m@x>', references: '<lost@x> <gone@x>' }]);
  assert.deepEqual(missing.map(r => r.node.key), ['<lost@x>', '<gone@x>', '<m@x>']);
  const cycle = threadTree([{ id: 'a', messageId: '<a@x>', inReplyTo: '<b@x>' }, { id: 'b', messageId: '<b@x>', inReplyTo: '<a@x>' }]);
  assert.equal(cycle.length, 2); assert.equal(new Set(cycle.map(r => r.node.key)).size, 2);
});
