import { extractPatch, replyFields, insertSignoff } from './compose.js';
import { threadTree } from './threading.js';

const $ = selector => document.querySelector(selector);
const escape = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
const folderQueries = { inbox: 'in:inbox', starred: 'is:starred', sent: 'in:sent', all: '-in:trash', trash: 'in:trash' };
const defaults = [
  { name: 'linux-kernel', address: 'linux-kernel.vger.kernel.org' },
  { name: 'linux-mm', address: 'linux-mm.kvack.org' },
  { name: 'linux-fsdevel', address: 'linux-fsdevel.vger.kernel.org' },
  { name: 'netdev', address: 'netdev.vger.kernel.org' },
  { name: 'linux-btrfs', address: 'linux-btrfs.vger.kernel.org' }
];
let lists = defaults;
try { const saved = JSON.parse(localStorage.getItem('plainpost-lists')); if (Array.isArray(saved) && saved.every(v => typeof v?.name === 'string' && typeof v?.address === 'string')) lists = saved; } catch { /* defaults */ }
const state = { status: {}, folder: 'inbox', list: null, query: '', unread: false, threads: [], selectedId: null, thread: null, activeMessageId: null, flat: false, page: 0, pageTokens: [''], nextPage: '', loading: false, listVersion: 0, threadVersion: 0, compose: null, composeBusy: false, sendKey: null, reviewedMessage: null };
let toastTimer;

function toast(message, error = false) {
  $('#toast').textContent = message; $('#toast').classList.toggle('error', error); $('#toast').hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('#toast').hidden = true; }, error ? 10000 : 5000);
}
function on(target, event, handler) {
  (typeof target === 'string' ? $(target) : target).addEventListener(event, e => {
    const fail = error => { toast(error.message, true); statusText('Action failed — see notification'); };
    try { Promise.resolve(handler(e)).catch(fail); } catch (error) { fail(error); }
  });
}
async function api(path, options = {}) {
  const method = options.method || 'GET';
  const response = await fetch(path, { ...options, credentials: 'same-origin', headers: { ...(method !== 'GET' ? { 'Content-Type': 'application/json', 'X-CSRF-Token': state.status.csrf } : {}), ...options.headers } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`);
  return data;
}
function statusText(text) { $('#status-text').textContent = text; }
function nameOf(value) { return value.replace(/<.*>/, '').replace(/^"|"$/g, '').trim() || value; }
function listName(value) { return value.replace(/[<>]/g, '').split('.')[0]; }
function relativeDate(value) {
  if (!value) return '';
  const date = new Date(value);
  if (date.toDateString() === new Date().toDateString()) return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}
function modal(id) { if (!$(id).open) $(id).showModal(); }
function requireConnection() { if (!state.status.connected) { modal('#settings-dialog'); return false; } return true; }

async function refreshStatus() {
  state.status = await api('/api/status');
  const demo = state.status.provider === 'demo';
  $('#workspace').classList.toggle('disconnected', !state.status.connected);
  $('#demo-banner').hidden = !demo;
  $('#compose-button').disabled = !state.status.connected;
  $('#disconnect-button').hidden = !state.status.connected;
  $('#connect-button').textContent = ['gmail', 'imap'].includes(state.status.provider) ? 'Gmail connected ✓' : demo ? 'Demo · Connect Gmail' : 'Connect Gmail';
  $('#account-name').textContent = demo ? 'Demo mailbox' : state.status.connected ? 'Gmail connected' : 'Local mailbox';
  $('#account-email').textContent = state.status.email || (state.status.mail.configured ? 'Home configuration ready' : 'Gmail setup required');
  $('#avatar').textContent = state.status.connected ? state.status.email[0].toUpperCase() : '@';
  $('#redirect-uri').textContent = `${state.status.appUrl}/auth/callback`;
  $('#mail-config-path').textContent = state.status.mail.path;
  $('#mail-config-error').textContent = state.status.mail.error;
  $('#settings-connect').textContent = 'Reload config & connect';
  $('#oauth-connect').disabled = !state.status.configured;
  $('#settings-demo').hidden = demo;
  $('#connection-description').textContent = state.status.connected && !demo ? `Connected as ${state.status.email} via ${state.status.provider === 'imap' ? 'IMAP + SMTP' : 'OAuth'}.` : 'Connect like Mutt: Gmail IMAP for reading, SMTP for sending, and a private app password in your home directory. No Google Cloud project is needed.';
  statusText(demo ? 'Demo ready · no external mail' : state.status.connected ? 'Gmail connected · ready' : state.status.mail.configured ? 'Ready to connect using home config' : 'Gmail setup required · public lore available');
}
async function connect(reload = false) {
  await refreshStatus();
  if (!reload && state.status.connected && state.status.provider !== 'demo') { modal('#settings-dialog'); return; }
  if (!state.status.mail.configured) { modal('#settings-dialog'); return; }
  const button = $('#settings-connect'); button.disabled = true;
  statusText('Checking Gmail IMAP and SMTP login…');
  try {
    await api('/api/connect/imap', { method: 'POST', body: '{}' });
    await refreshStatus(); $('#settings-dialog').close(); await loadMailbox();
    toast('Gmail connected using your home configuration.');
  } catch (error) { modal('#settings-dialog'); $('#mail-config-error').textContent = error.message; throw error; }
  finally { button.disabled = false; }
}
async function openDemo() {
  if (['gmail', 'imap'].includes(state.status.provider)) { toast('Disconnect your Gmail account before opening the isolated demo.'); return; }
  await api('/api/demo', { method: 'POST', body: '{}' });
  for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
  await refreshStatus(); state.folder = 'inbox'; state.list = null; state.query = ''; state.unread = false; $('#search').value = ''; await loadMailbox();
}
function renderLists() {
  $('#lists').innerHTML = lists.map((list, i) => `<div class="list-item${state.list?.address === list.address ? ' active' : ''}"><span class="list-dot"></span><button class="list-filter" data-list-index="${i}" title="${escape(list.address)}">${escape(list.name)}</button><button class="remove-list" data-remove-list="${i}" aria-label="Remove ${escape(list.name)} filter">×</button></div>`).join('');
}
function updateView() {
  const name = state.query ? 'Search results' : state.list?.name || (state.folder === 'all' ? 'All mail' : state.folder[0].toUpperCase() + state.folder.slice(1));
  $('#view-title').firstChild.textContent = name + ' ';
  $('#breadcrumb-folder').textContent = state.query ? 'search' : state.list?.name || state.folder;
  $('#view-eyebrow').textContent = state.list ? 'MAILING LIST' : state.query ? 'GMAIL SEARCH' : 'YOUR CONVERSATIONS';
  $('#unread-filter').setAttribute('aria-pressed', String(state.unread));
  $('#unread-filter').disabled = state.folder === 'drafts';
  $('#clear-search').hidden = !$('#search').value;
  for (const button of document.querySelectorAll('[data-folder]')) { button.classList.toggle('active', !state.list && state.folder === button.dataset.folder && !state.query); button.setAttribute('aria-current', button.classList.contains('active') ? 'page' : 'false'); }
  renderLists();
}
function mailboxQuery() {
  const query = state.query ? state.query : state.list ? `list:${state.list.address}` : folderQueries[state.folder] || 'in:inbox';
  return query + (state.unread ? ' is:unread' : '');
}
async function loadMailbox(reset = true) {
  if (!requireConnection()) return;
  $('#mailbox-index').hidden = false;
  history.replaceState(null, '', '/');
  if (reset) { state.page = 0; state.pageTokens = ['']; }
  const version = ++state.listVersion; ++state.threadVersion;
  state.loading = true; updateView(); statusText('Syncing mailbox…');
  $('#refresh-button').disabled = true;
  $('#thread-list').innerHTML = '<div class="list-empty"><span class="empty-glyph">[↻]</span><strong>Syncing conversations…</strong><p>Reading directly from your mailbox.</p></div>';
  $('#previous-page').disabled = true; $('#next-page').disabled = true;
  try {
    let result;
    if (state.folder === 'drafts' && !state.query && !state.list) {
      const response = await api(`/api/drafts?pageToken=${encodeURIComponent(state.pageTokens[state.page])}`);
      const drafts = [];
      for (let i = 0; i < response.drafts.length; i += 5) drafts.push(...await Promise.all(response.drafts.slice(i, i + 5).map(d => api(`/api/drafts/${encodeURIComponent(d.id)}`))));
      result = { threads: drafts.map(d => ({ id: `draft-${d.id}`, draftId: d.id, draft: d, subject: d.subject || '(no subject)', from: d.to || '(no recipient)', date: d.date || Date.now(), count: 1, listId: 'draft', unread: false })), nextPageToken: response.nextPageToken || '', resultSizeEstimate: drafts.length };
    } else result = await api(`/api/threads?q=${encodeURIComponent(mailboxQuery())}&pageToken=${encodeURIComponent(state.pageTokens[state.page])}`);
    if (version !== state.listVersion) return;
    state.threads = result.threads; state.nextPage = result.nextPageToken; state.thread = null;
    $('#thread-count').textContent = state.status.provider === 'imap' ? `${result.threads.length} on this page` : String(result.resultSizeEstimate);
    $('#thread-count').title = state.status.provider === 'imap' ? 'Conversations on this page; use Next for more' : 'Gmail’s estimated matching conversation count';
    $('#page-label').textContent = `PAGE ${state.page + 1}`;
    renderThreads();
    const selected = state.threads.find(t => t.id === state.selectedId) || state.threads[0];
    if (selected && !selected.draftId) await selectThread(selected.id, false);
    else { state.selectedId = null; state.thread = null; renderReaderEmpty(state.threads.length ? 'Open a draft to keep writing.' : 'All quiet here.', state.threads.length ? 'Your saved drafts are in the conversation pane.' : 'Try another folder, list, or search.'); }
    if (version === state.listVersion) statusText(`${state.status.provider === 'demo' ? 'Demo' : 'Gmail'} · ${state.threads.length} conversations on this page · synced ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`);
  } catch (error) {
    if (version === state.listVersion) { state.threads = []; state.selectedId = null; state.thread = null; renderThreads(); renderReaderEmpty('Couldn’t load this mailbox.', error.message); statusText('Mailbox sync failed'); }
    throw error;
  } finally {
    if (version === state.listVersion) { state.loading = false; $('#refresh-button').disabled = false; $('#previous-page').disabled = state.page === 0; $('#next-page').disabled = !state.nextPage; }
  }
}
function renderThreads() {
  $('#thread-list').innerHTML = state.threads.length ? state.threads.map(thread => `<button type="button" role="listitem" class="thread-row${thread.unread ? ' unread' : ''}${state.selectedId === thread.id ? ' selected' : ''}" data-thread-id="${escape(thread.id)}" aria-label="${escape(thread.subject)}" aria-current="${state.selectedId === thread.id}"><span>${thread.unread ? '*' : ' '}</span><span class="thread-subject">${escape(thread.subject)}</span><span class="thread-author">${escape(nameOf(thread.from))}</span><time>${escape(relativeDate(thread.date))}</time><span class="thread-bottom">[${thread.count}]${thread.starred ? ' *' : ''}</span></button>`).join('') : '<div class="list-empty">No conversations found. Try another list or Gmail search.</div>';
}
async function selectThread(id, reveal = true) {
  const thread = state.threads.find(t => t.id === id);
  if (!thread) return;
  if (thread.draftId) {
    if (!thread.draft.hasPlainText || thread.draft.hasAttachments) throw new Error('This Gmail draft contains HTML or attachments. Edit it in Gmail to preserve its content.');
    openComposer(thread.draft); return;
  }
  state.selectedId = id; state.thread = null; renderThreads();
  const row = document.querySelector(`[data-thread-id="${CSS.escape(id)}"]`); row?.scrollIntoView({ block: 'nearest' });
  const version = ++state.threadVersion;
  $('#reader').innerHTML = '<div class="list-empty"><span class="empty-glyph">[↻]</span><strong>Opening conversation…</strong></div>';
  const full = await api(`/api/threads/${encodeURIComponent(id)}`);
  if (version !== state.threadVersion) return;
  state.thread = full; state.activeMessageId = full.messages[0]?.id; renderReader(reveal);
  if (thread.unread) {
    await api(`/api/threads/${encodeURIComponent(id)}/modify`, { method: 'POST', body: JSON.stringify({ remove: ['UNREAD'] }) });
    if (version !== state.threadVersion) return;
    thread.unread = false; renderThreads();
  }
}
function renderReaderEmpty(title, detail) {
  $('#workspace').classList.remove('reader-open');
  $('#reader').innerHTML = `<div class="list-empty"><span class="empty-glyph">&gt;_</span><strong>${escape(title)}</strong><p>${escape(detail)}</p></div>`;
}
function styledBody(body) {
  return body.replace(/\r\n|\r/g, '\n').split('\n').map(line => {
    const cls = /^diff --git|^index |^@@|^--- |^\+\+\+ /.test(line) ? 'diff-meta' : /^\+/.test(line) ? 'diff-add' : /^-/.test(line) && line !== '-- ' ? 'diff-remove' : /^>/.test(line) ? 'quote' : /^(Signed-off-by|Reviewed-by|Acked-by|Tested-by|Fixes|Cc):/.test(line) ? 'trailer' : '';
    return `<span class="${cls}">${escape(line) || '\u200b'}</span>`;
  }).join('');
}
function archivePath(thread) { return thread.source === 'lore' ? `/api/lore/threads/${encodeURIComponent(thread.id)}` : `/api/threads/${encodeURIComponent(thread.id)}`; }
function rawPath(thread, message) { return thread.source === 'lore' ? `${archivePath(thread)}/messages/${encodeURIComponent(message.id)}/raw` : `/api/messages/${encodeURIComponent(message.id)}/raw`; }
function showMessage(id) {
  if (!state.thread?.messages.some(m => m.id === id)) return;
  state.activeMessageId = id; renderReader(false);
  history.replaceState(null, '', `${location.pathname}${location.search}#message=${encodeURIComponent(id)}`);
  $('#active-message').scrollIntoView({ block: 'start' });
}
async function importLore(url, preserveSelection = false) {
  const version = ++state.threadVersion; ++state.listVersion;
  state.loading = false; $('#refresh-button').disabled = false;
  $('#fetch-lore').disabled = true; statusText('Fetching full thread from lore.kernel.org…');
  try {
    const thread = await api('/api/lore/import', { method: 'POST', body: JSON.stringify({ url }) });
    if (version !== state.threadVersion) return;
    state.thread = thread; state.selectedId = null;
    const hashId = preserveSelection ? new URLSearchParams(location.hash.slice(1)).get('message') : null;
    state.activeMessageId = (thread.messages.find(m => m.id === hashId) || thread.messages.find(m => m.messageId === thread.requestedMessageId) || thread.messages[0])?.id;
    $('#workspace').classList.remove('disconnected'); $('#mailbox-index').hidden = true;
    $('#lore-url').value = url; $('#view-title').firstChild.textContent = 'Lore archive '; $('#thread-count').textContent = `${thread.messages.length} messages`;
    $('#view-eyebrow').textContent = 'PUBLIC ARCHIVE'; $('#breadcrumb-folder').textContent = 'lore.kernel.org';
    history.replaceState(null, '', `/?lore=${encodeURIComponent(url)}#message=${encodeURIComponent(state.activeMessageId)}`);
    renderReader(); statusText(`Lore · ${thread.messages.length} messages · public archive · reply using Gmail`);
  } finally { $('#fetch-lore').disabled = false; }
}
function renderReader(reveal = true) {
  const thread = state.thread;
  if (!thread?.messages.length) return;
  const rows = threadTree(thread.messages), current = rows.find(r => r.node.message?.id === state.activeMessageId) || rows.find(r => r.node.message);
  const message = current.node.message; state.activeMessageId = message.id;
  const ordered = rows.filter(r => r.node.message).map(r => r.node.message), index = ordered.indexOf(message);
  let parent = current.node.parent; while (parent && !parent.message) parent = parent.parent;
  const first = rows.find(r => r.node.message).node.message, summary = state.threads.find(t => t.id === thread.id), archive = thread.source === 'lore';
  const treeRows = state.flat ? [...rows.filter(r => r.node.message)].sort((a, b) => a.node.message.date - b.node.message.date) : rows;
  const link = (m, label) => `<a href="#message=${encodeURIComponent(m.id)}" data-message-id="${escape(m.id)}">${escape(label)}</a>`;
  const navigation = `<div class="message-navigation">${index > 0 ? link(ordered[index - 1], 'prev') : '<span>prev</span>'} / ${index < ordered.length - 1 ? link(ordered[index + 1], 'next') : '<span>next</span>'} / ${parent ? link(parent.message, 'parent') : '<span>root</span>'}<span class="current-info">[${index + 1}/${ordered.length}]</span></div>`;
  $('#reader').innerHTML = `<div class="reader-toolbar">${archive ? `<a href="${escape(thread.sourceUrl)}" target="_blank" rel="noopener noreferrer">view on lore</a><span>Public archive</span>` : `<button data-reader-action="archive" title="Archive (a)">archive</button><button data-reader-action="unread" title="Mark unread (u)">mark unread</button><button data-reader-action="star" title="Star (s)">${summary?.starred ? 'unstar' : 'star'}</button>${state.folder === 'trash' ? '<button data-reader-action="restore">restore</button>' : '<button data-reader-action="trash" title="Trash (d)">trash</button>'}`}<span class="toolbar-spacer"></span><a href="${archivePath(thread)}/mbox" download>download thread mbox</a></div><div class="reader-header"><h2>${escape(first.subject)}</h2><p>${escape(listName(first.listId) || (archive ? 'lore.kernel.org/all' : 'mailbox'))} · ${thread.messages.length} messages · select a reply below to read it</p></div><section class="thread-overview" aria-label="Thread overview"><div class="thread-overview-heading"><strong>Thread overview:</strong><span>${thread.messages.length} messages</span><button data-thread-view="nested" aria-pressed="${!state.flat}">nested</button> / <button data-thread-view="flat" aria-pressed="${state.flat}">flat</button></div><pre class="thread-tree">${treeRows.map(row => {
    const m = row.node.message, prefix = state.flat ? '' : row.prefix + (row.depth ? (row.last ? '\\-' : '|-') : '');
    if (!m) return `<span class="tree-row tree-missing">${escape(prefix)}[missing parent ${escape(row.node.key)}]</span>`;
    return `<span class="tree-row${m.id === message.id ? ' current' : ''}">${escape(prefix)}<span class="tree-date">${escape(new Date(m.date).toISOString().replace('T', ' ').slice(0, 16))}</span> ${link(m, m.subject || '(no subject)')} <span class="tree-author">${escape(nameOf(m.from))}</span>${m.id === message.id ? ' [this message]' : ''}</span>`;
  }).join('')}</pre></section><article id="active-message" aria-label="Selected message">${navigation}<div class="message-meta"><div><span class="meta-label">From:</span><span>${escape(message.from)}</span></div><div><span class="meta-label">To:</span><span>${escape(message.to)}</span></div>${message.cc ? `<div><span class="meta-label">Cc:</span><span>${escape(message.cc)}</span></div>` : ''}<div><span class="meta-label">Subject:</span><h3>${escape(message.subject)}</h3></div><div><span class="meta-label">Date:</span><span>${escape(new Date(message.date).toUTCString())}</span></div><div><span class="meta-label">Message-ID:</span><span>${escape(message.messageId)}</span></div>${message.inReplyTo ? `<div><span class="meta-label">In-Reply-To:</span><span>${escape(message.inReplyTo)}</span></div>` : ''}</div>${message.hasPlainText ? `<pre class="mail-body">${styledBody(message.body)}</pre>` : '<div class="html-notice">No text/plain body. HTML is hidden; download the original email to inspect it.</div>'}${message.attachments.length ? `<div class="attachment-list">${archive ? 'Attachments are available in the original .eml download: ' + message.attachments.map(a => escape(a.name)).join(', ') : message.attachments.map(a => `<a href="/api/messages/${encodeURIComponent(message.id)}/attachments/${encodeURIComponent(a.id)}" download="${escape(a.name)}">${escape(a.name)}</a>`).join(' · ')}</div>` : ''}<div class="message-actions"><button data-reply-id="${escape(message.id)}" ${!message.messageId ? 'disabled' : ''}>Reply</button><button data-reply-all-id="${escape(message.id)}" ${!message.messageId ? 'disabled' : ''}>Reply all</button><button data-patch-id="${escape(message.id)}" ${!message.hasPlainText ? 'disabled' : ''}>Download text / patch</button><a href="${rawPath(thread, message)}" download>raw .eml</a>${archive ? `<a href="${escape(message.sourceUrl)}" target="_blank" rel="noopener noreferrer">permalink on lore</a>` : ''}</div>${navigation}</article>`;
  if (reveal) $('#workspace').classList.add('reader-open');
}
async function modify(action) {
  if (state.thread?.source === 'lore' || !state.selectedId || state.thread?.id !== state.selectedId) return;
  const id = state.selectedId, selected = state.threads.find(t => t.id === id);
  const operations = { archive: { remove: ['INBOX'] }, unread: { add: ['UNREAD'] }, trash: { add: ['TRASH'], remove: ['INBOX'] }, restore: { add: ['INBOX'], remove: ['TRASH'] }, star: selected?.starred ? { remove: ['STARRED'] } : { add: ['STARRED'] } };
  await api(`/api/threads/${encodeURIComponent(id)}/modify`, { method: 'POST', body: JSON.stringify(operations[action]) });
  if (action === 'star' || action === 'unread') {
    if (selected) { if (action === 'star') selected.starred = !selected.starred; else selected.unread = true; }
    renderThreads(); if (state.selectedId === id) renderReader($('#workspace').classList.contains('reader-open'));
  } else await loadMailbox(false);
  toast({ archive: 'Thread archived.', trash: 'Thread moved to trash.', restore: 'Thread restored to inbox.', unread: 'Thread marked unread.', star: selected?.starred ? 'Thread starred.' : 'Star removed.' }[action]);
}
function downloadText(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = name; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function draftStorageKey() { return `plainpost-draft:${state.status.provider}:${state.status.email}`; }
function readComposer() {
  return { ...state.compose, to: $('#compose-to').value, cc: $('#compose-cc').value, bcc: $('#compose-bcc').value, subject: $('#compose-subject').value, body: $('#compose-body').value };
}
function updateComposeStats() {
  const body = $('#compose-body').value, bytes = new TextEncoder().encode(body).length;
  const long = body.split('\n').some(line => new TextEncoder().encode(line).length > 998);
  $('#compose-stats').textContent = `${body.split('\n').length} lines · ${bytes.toLocaleString()} bytes${long ? ' · line > 998 bytes' : ''}`;
  $('#draft-status').textContent = state.compose?.draftId ? 'Edited · save to sync' : 'Draft kept in this tab';
  state.sendKey = null;
  try { sessionStorage.setItem(draftStorageKey(), JSON.stringify(readComposer())); } catch { $('#draft-status').textContent = 'Browser draft storage unavailable'; }
}
function openComposer(initial) {
  if (!requireConnection()) return;
  if ($('#compose-dialog').open) { toast('Finish or close your current draft first.'); return; }
  let restore;
  try { restore = JSON.parse(sessionStorage.getItem(draftStorageKey())); } catch { /* empty */ }
  if (initial && restore && (restore.body || restore.subject)) { toast('A draft is already saved in this tab. Compose opens it; discard it before starting another reply.'); initial = restore; }
  state.compose = { to: '', cc: '', bcc: '', subject: '', body: '', references: '', inReplyTo: '', threadId: '', draftId: '', ...(initial || restore || {}) };
  // Gmail draft IDs and message IDs are distinct.
  if (initial?.id && !initial.draftId) state.compose.draftId = initial.id;
  state.sendKey = null;
  for (const field of ['to', 'cc', 'bcc', 'subject', 'body']) $(`#compose-${field}`).value = state.compose[field] || '';
  $('#compose-from').textContent = state.status.from || state.status.email;
  $('#compose-title').textContent = state.compose.inReplyTo ? 'Inline reply' : state.compose.draftId ? 'Edit draft' : 'New message';
  updateComposeStats();
  $('#draft-status').textContent = state.compose.draftId ? (state.status.provider === 'demo' ? 'Saved in demo' : 'Saved in Gmail') : restore ? 'Restored from this tab' : 'Unsaved draft';
  modal('#compose-dialog');
  if (state.compose.body) { $('#compose-body').focus(); $('#compose-body').setSelectionRange(state.compose.body.length, state.compose.body.length); }
  else $('#compose-to').focus();
}
function reply(id, all = false) {
  const message = state.thread?.messages.find(m => m.id === (id || state.activeMessageId)) || state.thread?.messages.at(-1);
  if (!message) return;
  if (!message.messageId) { toast('This message has no Message-ID; a threaded reply cannot be created.', true); return; }
  openComposer(replyFields(message, state.status.email, all));
}
function composeBusy(busy) {
  state.composeBusy = busy;
  for (const selector of ['#save-draft', '#review-send', '#discard-draft', '#close-compose', '#confirm-send']) $(selector).disabled = busy;
  for (const element of document.querySelectorAll('#compose-form input, #compose-form textarea, .compose-tools button, #send-dialog [data-close]')) element.disabled = busy;
}
async function saveDraft() {
  if (state.composeBusy) return;
  if (!$('#compose-form').reportValidity()) return;
  composeBusy(true);
  try {
    const input = readComposer(), result = await api('/api/drafts', { method: 'POST', body: JSON.stringify(input) });
    state.compose = { ...input, draftId: result.id };
    try { sessionStorage.setItem(draftStorageKey(), JSON.stringify(state.compose)); } catch { /* optional cache */ }
    $('#draft-status').textContent = state.status.provider === 'demo' ? 'Saved in demo' : 'Saved in Gmail';
    toast(state.status.provider === 'demo' ? 'Draft saved in the demo mailbox.' : 'Plain-text draft saved to Gmail.');
  } finally { composeBusy(false); }
}
function reviewSend(event) {
  event?.preventDefault(); if (state.composeBusy || $('#send-dialog').open) return;
  if (!$('#compose-form').reportValidity()) return;
  const input = readComposer();
  state.sendKey ||= crypto.randomUUID();
  state.reviewedMessage = { ...input, sendKey: state.sendKey };
  $('#send-title').textContent = state.status.provider === 'demo' ? 'Send to the demo mailbox?' : 'Ready to send?';
  $('#send-details').innerHTML = ['to', 'cc', 'bcc', 'subject'].filter(key => input[key]).map(key => `<div class="send-detail"><span>${escape(key)}</span><strong>${escape(input[key])}</strong></div>`).join('');
  $('#send-preview').textContent = input.body;
  const patch = /^diff --git/m.test(input.body);
  const signoff = /^Signed-off-by:/m.test(input.body);
  $('#send-note').textContent = state.status.provider === 'demo' ? 'This creates a sample message only. No mail leaves your machine.' : `${patch && !signoff ? 'This patch has no Signed-off-by trailer. Check the contribution requirements before sending. ' : ''}Sending as ${state.status.from || state.status.email}. Plain text, UTF-8, original spacing. ${input.inReplyTo ? 'Threading headers are included.' : ''}`;
  modal('#send-dialog');
}
async function sendMessage() {
  if (state.composeBusy || !$('#send-dialog').open || !state.reviewedMessage) return;
  composeBusy(true); $('#confirm-send').textContent = 'Sending…';
  try {
    const result = await api('/api/send', { method: 'POST', body: JSON.stringify(state.reviewedMessage) });
    $('#send-dialog').close(); $('#compose-dialog').close(); sessionStorage.removeItem(draftStorageKey()); state.compose = null;
    toast(result.warning || (state.status.provider === 'demo' ? 'Message sent inside the demo mailbox.' : 'Plain-text message sent through Gmail.'), !!result.warning);
    await loadMailbox(false);
  } finally { composeBusy(false); $('#confirm-send').textContent = 'Send message ↗'; }
}

for (const button of document.querySelectorAll('[data-close]')) on(button, 'click', () => $(`#${button.dataset.close}`).close());
for (const id of ['#connect-button', '#welcome-connect', '#demo-connect']) on(id, 'click', () => connect());
on('#settings-connect', 'click', () => connect(true));
on('#oauth-connect', 'click', () => window.location.assign('/auth/start'));
for (const id of ['#demo-button', '#settings-demo']) on(id, 'click', openDemo);
for (const id of ['#help-button', '#footer-help']) on(id, 'click', () => modal('#help-dialog'));
on('#settings-button', 'click', async () => { await refreshStatus(); modal('#settings-dialog'); });
on('#disconnect-button', 'click', async () => {
  if (state.composeBusy) return;
  await api('/api/logout', { method: 'POST', body: '{}' }); sessionStorage.removeItem(draftStorageKey()); window.location.reload();
});
on('#compose-button', 'click', () => openComposer());
on('#refresh-button', 'click', () => state.thread?.source === 'lore' ? importLore(state.thread.sourceUrl, true) : loadMailbox(false));
on('#lore-form', 'submit', event => { event.preventDefault(); return importLore($('#lore-url').value.trim()); });
on('#folders', 'click', async event => {
  const folder = event.target.closest('[data-folder]'); if (!folder || !requireConnection()) return;
  state.folder = folder.dataset.folder; state.list = null; state.query = ''; state.unread = false; $('#search').value = ''; $('#workspace').classList.remove('reader-open'); await loadMailbox();
});
on('#lists', 'click', async event => {
  const remove = event.target.closest('[data-remove-list]');
  if (remove) { const [removed] = lists.splice(Number(remove.dataset.removeList), 1); localStorage.setItem('plainpost-lists', JSON.stringify(lists)); if (state.list?.address === removed.address) { state.list = null; if (state.status.connected) await loadMailbox(); } renderLists(); return; }
  const button = event.target.closest('[data-list-index]'); if (!button || !requireConnection()) return;
  state.list = lists[Number(button.dataset.listIndex)]; state.folder = 'inbox'; state.query = ''; $('#search').value = ''; $('#workspace').classList.remove('reader-open'); await loadMailbox();
});
on('#add-list', 'click', () => modal('#list-dialog'));
on('#list-form', 'submit', event => {
  event.preventDefault(); const name = $('#list-name').value.trim(), address = $('#list-address').value.trim();
  if (!/^[a-zA-Z0-9@._+-]+$/.test(address)) throw new Error('Use a List-ID or email address without spaces or Gmail query operators.');
  if (lists.some(l => l.address === address)) throw new Error('This list filter already exists.');
  lists.push({ name, address }); localStorage.setItem('plainpost-lists', JSON.stringify(lists)); renderLists(); $('#list-dialog').close(); $('#list-form').reset(); toast('Mailing list filter added.');
});
on('#search-form', 'submit', async event => { event.preventDefault(); state.query = $('#search').value.trim(); await loadMailbox(); });
on('#search', 'input', () => { $('#clear-search').hidden = !$('#search').value; });
on('#clear-search', 'click', async () => { $('#search').value = ''; state.query = ''; await loadMailbox(); });
on('#unread-filter', 'click', async () => { state.unread = !state.unread; await loadMailbox(); });
on('#next-page', 'click', async () => { if (!state.nextPage || state.loading) return; state.pageTokens[++state.page] = state.nextPage; await loadMailbox(false); });
on('#previous-page', 'click', async () => { if (!state.page || state.loading) return; --state.page; await loadMailbox(false); });
on('#thread-list', 'click', event => { const row = event.target.closest('[data-thread-id]'); if (row) return selectThread(row.dataset.threadId); });
on('#reader', 'click', event => {
  const messageLink = event.target.closest('[data-message-id]');
  if (messageLink) { event.preventDefault(); showMessage(messageLink.dataset.messageId); return; }
  const view = event.target.closest('[data-thread-view]');
  if (view) { state.flat = view.dataset.threadView === 'flat'; renderReader(false); return; }
  const action = event.target.closest('[data-reader-action]');
  if (action) { if (action.dataset.readerAction === 'back') $('#workspace').classList.remove('reader-open'); else return modify(action.dataset.readerAction); }
  const one = event.target.closest('[data-reply-id]'), all = event.target.closest('[data-reply-all-id]'), patch = event.target.closest('[data-patch-id]');
  if (one) reply(one.dataset.replyId); if (all) reply(all.dataset.replyAllId, true);
  if (patch) { const message = state.thread.messages.find(m => m.id === patch.dataset.patchId); downloadText(message.subject.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 100) + (/^diff --git/m.test(message.body) ? '.patch' : '.txt'), message.body); }
});
on('#compose-form', 'input', updateComposeStats);
on('#compose-form', 'submit', reviewSend);
on('#save-draft', 'click', saveDraft);
on('#close-compose', 'click', () => { if (!state.composeBusy) { updateComposeStats(); $('#compose-dialog').close(); toast('Draft kept in this browser tab. Press c to resume.'); } });
on('#compose-dialog', 'cancel', event => { if (state.composeBusy) event.preventDefault(); else updateComposeStats(); });
on('#send-dialog', 'cancel', event => { if (state.composeBusy) event.preventDefault(); });
on('#discard-draft', 'click', () => { if (state.composeBusy) return; sessionStorage.removeItem(draftStorageKey()); $('#compose-dialog').close(); state.compose = null; toast(state.status.provider === 'demo' ? 'Local draft discarded. Previously saved demo drafts stay in the demo mailbox.' : 'Local draft discarded. Previously saved Gmail drafts stay in Gmail.'); });
on('#confirm-send', 'click', sendMessage);
on('#compose-body', 'keydown', event => {
  if (event.key === 'Tab' && !event.shiftKey) { event.preventDefault(); const input = event.target; input.setRangeText('\t', input.selectionStart, input.selectionEnd, 'end'); updateComposeStats(); }
  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); reviewSend(); }
});
on('#add-signoff', 'click', () => {
  const body = $('#compose-body'), name = nameOf(state.status.email).split('@')[0];
  body.value = insertSignoff(body.value, `Signed-off-by: ${name} <${state.status.email}>`); updateComposeStats(); body.focus(); body.setSelectionRange(body.value.length, body.value.length); toast('Edit the sign-off name to match your contribution identity.');
});
on('#patch-file', 'change', async event => {
  const file = event.target.files[0]; if (!file) return;
  try {
    if (file.size > 2 * 1024 * 1024) throw new Error('Patch files must be under 2 MiB.');
    const bytes = await file.arrayBuffer(); let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new Error('Patch files must be UTF-8 text.'); }
    if (text.includes('\0')) throw new Error('Binary files cannot be inserted into a plain-text message.');
    const patch = extractPatch(text), body = $('#compose-body');
    if (patch.subject && !$('#compose-subject').value) $('#compose-subject').value = patch.subject;
    const start = body.selectionStart, end = body.selectionEnd;
    body.setRangeText(patch.body, start, end, 'end'); updateComposeStats(); body.focus(); toast(`Inserted ${file.name} inline. Spacing preserved.`);
  } finally { event.target.value = ''; }
});
on(document, 'keydown', event => {
  if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || event.target.closest('input, textarea, select, [contenteditable=true]') || document.querySelector('dialog[open]')) return;
  if (event.key === '?') { event.preventDefault(); modal('#help-dialog'); return; }
  if (event.key === '/') { event.preventDefault(); $('#search').focus(); return; }
  if (event.key === 'c') { event.preventDefault(); openComposer(); return; }
  if (event.key === 'Escape') { $('#workspace').classList.remove('reader-open'); if (state.query) { state.query = ''; $('#search').value = ''; return loadMailbox(); } }
  if (['[', ']'].includes(event.key) && state.thread) { event.preventDefault(); const ordered = threadTree(state.thread.messages).filter(r => r.node.message).map(r => r.node.message); const index = ordered.findIndex(m => m.id === state.activeMessageId); showMessage(ordered[Math.max(0, Math.min(ordered.length - 1, index + (event.key === ']' ? 1 : -1)))].id); return; }
  if ((event.key === 'r' || event.key === 'R') && state.thread) { event.preventDefault(); reply(undefined, event.key === 'R'); return; }
  if (!state.status.connected || state.loading || state.thread?.source === 'lore') return;
  if (['j', 'k', 'ArrowDown', 'ArrowUp'].includes(event.key)) {
    event.preventDefault(); const index = Math.max(0, state.threads.findIndex(t => t.id === state.selectedId)); const next = Math.min(state.threads.length - 1, Math.max(0, index + (['j', 'ArrowDown'].includes(event.key) ? 1 : -1))); return selectThread(state.threads[next]?.id);
  }
  if (event.key === 'Enter' && state.selectedId) return selectThread(state.selectedId);
  if (event.key === 'r' || event.key === 'R') { event.preventDefault(); reply(undefined, event.key === 'R'); }
  const action = { a: 'archive', d: 'trash', s: 'star', u: 'unread' }[event.key]; if (action) { event.preventDefault(); return modify(action); }
});
on(window, 'beforeunload', event => { if (state.composeBusy) { event.preventDefault(); event.returnValue = ''; } });

async function initialize() {
  renderLists(); await refreshStatus();
  const error = new URLSearchParams(window.location.search).get('auth_error');
  if (error) {
    const messages = { setup_required: 'Add your Google OAuth credentials to .env and restart the server.', invalid_state: 'Login expired or came from another browser session. Try connecting again.', denied: 'Google sign-in was cancelled.', missing_code: 'Google did not return an authorization code.', exchange_failed: 'Gmail connection failed. Check your client credentials, Gmail API, redirect URI, and granted permissions.' };
    toast(messages[error] || 'Gmail sign-in failed.', true); modal('#settings-dialog'); history.replaceState(null, '', '/');
  }
  const lore = new URLSearchParams(location.search).get('lore');
  if (lore) await importLore(lore, true);
  else if (state.status.connected) await loadMailbox();
}
initialize().catch(error => toast(error.message, true));
