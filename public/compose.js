// These helpers preserve the body verbatim, except for normalizing line endings.
export function extractPatch(text) {
  const normalized = text.replace(/\r\n|\r/g, '\n');
  if (/^From [0-9a-f]{40,64} Mon Sep 17 00:00:00 2001\n/.test(normalized) || /^(?:From|Subject|Date): /m.test(normalized.split('\n\n')[0])) {
    const boundary = normalized.indexOf('\n\n');
    if (boundary < 0) throw new Error('This email has no header/body boundary.');
    const head = normalized.slice(0, boundary).replace(/\n[ \t]+/g, ' ');
    if (/^Content-Type: (?!text\/plain)/mi.test(head) || /^Content-Transfer-Encoding: (?:base64|quoted-printable)/mi.test(head)) throw new Error('Insert a UTF-8 patch or an unencoded text/plain email. Encoded MIME email is not imported.');
    let subject = head.match(/^Subject: (.+)$/mi)?.[1] || '';
    subject = subject.replace(/=\?utf-8\?b\?([^?]+)\?=/gi, (_, value) => new TextDecoder().decode(Uint8Array.from(atob(value), c => c.charCodeAt(0))));
    return { subject, body: normalized.slice(boundary + 2) };
  }
  return { subject: '', body: normalized };
}

export function recipientEmails(value = '') {
  return [...value.matchAll(/[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+/g)].map(match => match[0]);
}

export function insertSignoff(body, trailer) {
  // Keep commit trailers above the format-patch separator and diffstat.
  const separator = body.search(/^---\r?$/m);
  const position = separator >= 0 && /^diff --git/m.test(body) ? separator : body.length;
  let before = body.slice(0, position);
  const lastLine = before.trimEnd().split('\n').at(-1) || '';
  if (before && !before.endsWith('\n')) before += '\n';
  if (before.trim() && !before.endsWith('\n\n') && !/^(?:Signed-off-by|Reviewed-by|Acked-by|Tested-by):/.test(lastLine)) before += '\n';
  return before + trailer + '\n' + body.slice(position);
}

export function replyFields(message, accountEmail, replyAll = false) {
  const own = accountEmail.toLowerCase();
  const dedupe = list => [...new Set(list.map(v => v.toLowerCase()))].filter(v => v !== own);
  const replyAddress = message.replyTo || message.from;
  let to = dedupe(recipientEmails(replyAddress));
  if (!to.length) to = dedupe(recipientEmails(message.to)); // replying to a sent message
  let cc = [];
  if (replyAll) cc = dedupe([...recipientEmails(message.to), ...recipientEmails(message.cc), ...recipientEmails(message.listPost)]).filter(v => !to.includes(v));
  const quoted = message.body.replace(/\r\n|\r/g, '\n').split('\n').map(line => line ? `> ${line}` : '>').join('\n');
  const date = new Date(message.date).toUTCString();
  const body = `On ${date}, ${message.from} wrote:\n${quoted}\n\n`;
  return { to: to.join(', '), cc: cc.join(', '), bcc: '', subject: /^Re:/i.test(message.subject) ? message.subject : `Re: ${message.subject}`, body, threadId: message.threadId, inReplyTo: message.messageId, references: message.references || '', draftId: '' };
}
