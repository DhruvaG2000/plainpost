import { fetchLore } from '../server/lore.mjs';
import { threadTree } from '../public/threading.js';
const url = process.argv[2] || 'https://lore.kernel.org/lkml/20200313231252.64999-1-keescook@chromium.org/';
const { thread } = await fetchLore(url);
const rows = threadTree(thread.messages);
console.log(JSON.stringify({ source: thread.sourceUrl, messages: thread.messages.length, maxReplyDepth: Math.max(...rows.map(r => r.depth)), subject: thread.messages[0].subject, plainTextMessages: thread.messages.filter(m => m.hasPlainText).length }, null, 2));
