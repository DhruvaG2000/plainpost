import { randomUUID } from 'node:crypto';
import { AppError, buildRawMail } from './mail.mjs';

const patch = `The wakeup path can observe a stale CPU mask when a task migrates
between the affinity check and the enqueue operation. Recheck the
destination under the runqueue lock before completing the wakeup.

Signed-off-by: Alex Morgan <alex@example.org>
---
 kernel/sched/core.c | 4 ++++
 1 file changed, 4 insertions(+)

diff --git a/kernel/sched/core.c b/kernel/sched/core.c
index 5d7a21e..9c4b280 100644
--- a/kernel/sched/core.c
+++ b/kernel/sched/core.c
@@ -3188,6 +3188,10 @@ static void ttwu_queue(struct task_struct *p, int cpu, int wake_flags)
 \tstruct rq *rq = cpu_rq(cpu);
 \tstruct rq_flags rf;
\x20
+\t/* Validate the destination after acquiring the runqueue lock. */
+\tif (!cpumask_test_cpu(cpu, p->cpus_ptr))
+\t\tcpu = select_task_rq(p, p->wake_cpu, wake_flags);
+
 \trq_lock(rq, &rf);
 \tupdate_rq_clock(rq);
--\x20
2.47.0
`;
const seeds = [
  ['[PATCH v3 1/2] sched: recheck affinity during task wakeup', 'Alex Morgan', 'linux-kernel', patch, 3],
  ['[PATCH v3 2/2] sched: add coverage for concurrent migration', 'Alex Morgan', 'linux-kernel', 'Add a regression test exercising affinity changes during wakeup.\n\nThis is the second patch of the demo series.\n\nSigned-off-by: Alex Morgan <alex@example.org>\n', 1],
  ['[RFC PATCH 0/3] mm: simplify folio reclaim accounting', 'Sam Chen', 'linux-mm', 'Hi everyone,\n\nThis series removes a redundant counter in the folio reclaim path.\nI would appreciate feedback on the accounting changes before v2.\n\nThe series is based on the current mm tree.\n\nThanks,\nSam\n', 2],
  ['Re: [PATCH] btrfs: handle interrupted writeback correctly', 'Jordan Lee', 'linux-btrfs', 'On Monday, Taylor wrote:\n> The interrupted writeback path leaves a stale extent flag.\n\nThe approach looks reasonable. Could you add a regression test to\ncover the short write before reposting?\n\nReviewed-by: Jordan Lee <jordan@example.org>\n', 4],
  ['[PATCH net-next] net: avoid redundant socket lookup', 'Taylor Quinn', 'netdev', 'Cache the result of the first lookup for use in the retry path.\n\nSigned-off-by: Taylor Quinn <taylor@example.org>\n---\n net/core/sock.c | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)\n', 1],
  ['Re: [RFC] filesystem test coverage for compressed extents', 'Casey Patel', 'linux-fsdevel', 'The test should also check the extent boundary after a partial\noverwrite. I can run the next version on my test system.\n\nThanks,\nCasey\n', 2],
  ['[PATCH] drm: document the connector lifetime rules', 'Riley Brooks', 'dri-devel', 'Clarify who owns the connector reference during teardown.\n\nSigned-off-by: Riley Brooks <riley@example.org>\n', 1],
  ['[ANNOUNCE] Kernel community testing notes', 'Morgan Blake', 'linux-kernel', 'A few notes from this week’s testing:\n\n- Boot coverage on x86_64 and arm64\n- Filesystem regression tests\n- Scheduler stress tests\n\nPlease reply inline with any additional results.\n', 1],
  ['[PATCH v2] mm: improve page allocation diagnostics', 'Jamie Ellis', 'linux-mm', 'Include the allocation order in the failure diagnostics.\n\nSigned-off-by: Jamie Ellis <jamie@example.org>\n', 2],
  ['Re: [PATCH] riscv: clean up early boot helpers', 'Drew Kim', 'linux-kernel', 'On Tuesday, Riley wrote:\n> This helper can be shared between both boot paths.\n\nAgreed. Please keep the comment describing the MMU-off case.\n\nAcked-by: Drew Kim <drew@example.org>\n', 1]
];

export class DemoMailbox {
  constructor() {
    this.threads = new Map(); this.savedDrafts = new Map();
    seeds.forEach(([subject, name, list, body, count], i) => {
      const threadId = `demo-${i + 1}`;
      const messages = Array.from({ length: count }, (_, n) => ({
        id: `${threadId}-${n + 1}`, threadId, subject: n ? `Re: ${subject.replace(/^Re: /, '')}` : subject,
        from: n ? 'Robin Avery <robin@example.org>' : `${name} <${name.toLowerCase().split(' ')[0]}@example.org>`,
        to: `${list}@${list === 'linux-mm' ? 'kvack.org' : 'vger.kernel.org'}`, cc: '', replyTo: '',
        body: n ? `On the previous message:\n> ${body.split('\n')[0]}\n\n${n === count - 1 ? 'Thanks for the review. I’ll include this in the next revision.' : 'Could you explain how this interacts with the migration path?'}\n` : body,
        date: Date.now() - i * 3600000 - (count - n) * 60000,
        messageId: `<${threadId}.${n + 1}@example.org>`, inReplyTo: n ? `<${threadId}.${n}@example.org>` : '', references: Array.from({ length: n }, (_, j) => `<${threadId}.${j + 1}@example.org>`).join(' '),
        listId: `${list}.${list === 'linux-mm' ? 'kvack.org' : 'vger.kernel.org'}`, listPost: `<mailto:${list}@${list === 'linux-mm' ? 'kvack.org' : 'vger.kernel.org'}>`,
        labelIds: ['INBOX', ...(i < 4 ? ['UNREAD'] : []), ...(i === 2 ? ['STARRED'] : [])],
        snippet: body.slice(0, 140), attachments: [], hasPlainText: true
      }));
      this.threads.set(threadId, { id: threadId, messages });
    });
  }
  async labels() { return ['INBOX', 'SENT', 'DRAFT', 'STARRED', 'TRASH'].map(id => ({ id, name: id, type: 'system' })); }
  async list({ q = '', pageToken = '' } = {}) {
    let result = [...this.threads.values()];
    const terms = q.match(/(?:[^\s"]+|"[^"]*")+/g) || [];
    for (const term of terms) {
      const lower = term.toLowerCase(), value = lower.replace(/^[^:]+:/, '').replace(/"/g, '');
      if (lower.startsWith('in:')) result = result.filter(t => t.messages.some(m => m.labelIds.includes(({ inbox: 'INBOX', sent: 'SENT', drafts: 'DRAFT', trash: 'TRASH' })[value] || value.toUpperCase())));
      else if (lower === 'is:unread' || lower === 'is:starred') result = result.filter(t => t.messages.some(m => m.labelIds.includes(lower === 'is:unread' ? 'UNREAD' : 'STARRED')));
      else if (lower.startsWith('list:')) result = result.filter(t => t.messages.some(m => m.listId.includes(value)));
      else if (lower.startsWith('from:') || lower.startsWith('to:') || lower.startsWith('subject:')) result = result.filter(t => t.messages.some(m => m[lower.split(':')[0]].toLowerCase().includes(value)));
      else if (lower === '-in:trash') result = result.filter(t => !t.messages.some(m => m.labelIds.includes('TRASH')));
      else result = result.filter(t => t.messages.some(m => `${m.subject} ${m.body} ${m.from}`.toLowerCase().includes(lower.replace(/"/g, ''))));
    }
    result.sort((a, b) => b.messages.at(-1).date - a.messages.at(-1).date);
    const offset = Number(pageToken) || 0;
    return { threads: result.slice(offset, offset + 30).map(t => {
      const last = t.messages.at(-1);
      return { id: t.id, subject: t.messages[0].subject, from: last.from, date: last.date, count: t.messages.length, snippet: last.snippet, listId: t.messages[0].listId || last.listId, labels: [...new Set(t.messages.flatMap(m => m.labelIds))], unread: t.messages.some(m => m.labelIds.includes('UNREAD')), starred: t.messages.some(m => m.labelIds.includes('STARRED')) };
    }), nextPageToken: offset + 30 < result.length ? String(offset + 30) : '', resultSizeEstimate: result.length };
  }
  async thread(id) { const thread = this.threads.get(id); if (!thread) throw new AppError('Thread not found.', 404); return structuredClone(thread); }
  async modify(id, add, remove) { const thread = this.threads.get(id); if (!thread) throw new AppError('Thread not found.', 404); for (const message of thread.messages) message.labelIds = [...new Set([...message.labelIds.filter(l => !remove.includes(l)), ...add])]; return {}; }
  async send(raw, threadId) {
    const id = randomUUID();
    const split = raw.indexOf('\r\n\r\n');
    const headers = raw.slice(0, split).replace(/\r\n[ \t]/g, ' ');
    const h = name => headers.match(new RegExp(`^${name}: (.*)$`, 'mi'))?.[1] || '';
    const message = { id, threadId: threadId || id, from: h('From'), to: h('To'), cc: h('Cc'), subject: h('Subject'), body: raw.slice(split + 4), date: Date.now(), messageId: h('Message-ID'), inReplyTo: h('In-Reply-To'), references: h('References'), listId: '', listPost: '', labelIds: ['SENT'], attachments: [], hasPlainText: true, snippet: raw.slice(split + 4, split + 144), raw };
    const thread = this.threads.get(threadId) || { id: message.threadId, messages: [] };
    thread.messages.push(message); this.threads.set(thread.id, thread);
    return { id, threadId: thread.id };
  }
  async drafts() { return { drafts: [...this.savedDrafts.values()].map(d => ({ id: d.id, message: { threadId: d.threadId } })) }; }
  async draft(id) { const draft = this.savedDrafts.get(id); if (!draft) throw new AppError('Draft not found.', 404); return structuredClone(draft); }
  async saveDraft(raw, threadId, id) {
    const draftId = id || randomUUID();
    const headers = raw.slice(0, raw.indexOf('\r\n\r\n')).replace(/\r\n[ \t]/g, ' ');
    const h = name => headers.match(new RegExp(`^${name}: (.*)$`, 'mi'))?.[1] || '';
    this.savedDrafts.set(draftId, { id: draftId, raw, threadId, to: h('To'), cc: h('Cc'), bcc: h('Bcc'), subject: h('Subject'), body: raw.slice(raw.indexOf('\r\n\r\n') + 4), from: h('From'), inReplyTo: h('In-Reply-To'), references: h('References'), hasPlainText: true, hasAttachments: false });
    return { id: draftId };
  }
  async sendDraft(id) { const draft = await this.draft(id); const sent = await this.send(draft.raw, draft.threadId); this.savedDrafts.delete(id); return sent; }
  async raw(id) { const message = [...this.threads.values()].flatMap(t => t.messages).find(m => m.id === id); if (!message) throw new AppError('Message not found.', 404); return Buffer.from(message.raw || buildRawMail({ to: message.to, cc: message.cc, subject: message.subject, body: message.body, inReplyTo: message.inReplyTo, references: message.references }, message.from, new Date(message.date)).replace(/^Message-ID: .*$/m, `Message-ID: ${message.messageId}`)); }
  async attachment() { throw new AppError('No attachments in this demo.', 404); }
}
