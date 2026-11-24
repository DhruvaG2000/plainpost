import { mountComposer } from './editor.js';

export function mountPatchSeries({ api, styledBody, escape }) {
  const $ = selector => document.querySelector(selector);
  const dialog = $('#patch-series-dialog'), previewDialog = $('#series-preview-dialog');
  const editForm = $('#series-edit'), loadForm = $('#series-load');
  const selector = $('#series-message'), send = $('#confirm-series');
  const editStatus = $('#series-edit-status'), sendStatus = $('#series-send-status');
  const draftFields = ['to', 'cc', 'subject'];
  let draft = null, preview = null, selected = 0, busy = false, attempted = false;
  const editor = mountComposer($('#series-body'), {
    change: () => { if (draft) draft.messages[selected].body = editor.getValue(); },
    review: () => editForm.requestSubmit(),
    highlight: $('#series-highlight'),
    vim: $('#series-vim'),
    vimStatus: $('#series-vim-status')
  });

  function status(element, text, error = false) {
    element.textContent = text;
    element.classList.toggle('error', error);
  }

  function setBusy(value) {
    busy = value;
    for (const element of document.querySelectorAll('#series-load input, #series-load button, #series-edit input, #series-edit select, #series-edit button, #patch-series-dialog .dialog-heading button, #series-preview-dialog button')) {
      element.disabled = value;
    }
    editor.setOption('readOnly', busy);
    send.disabled = value || attempted;
    editForm.querySelector('[type=submit]').disabled = value || attempted;
  }

  async function run(element, label, action) {
    if (busy) return;
    setBusy(true);
    status(element, label);
    try { await action(); }
    catch (error) { status(element, error.message, true); }
    finally { setBusy(false); }
  }

  function showMessage(index) {
    selected = index;
    const message = draft.messages[index];
    for (const field of draftFields) $(`#series-message-${field}`).value = message[field];
    $('#series-source').textContent = message.filename;
    editor.setValue(message.body);
    editor.clearHistory();
    editor.refresh();
  }

  function applyRecipients(local, common) {
    return [local.trim(), common.trim()].filter(Boolean).join(', ');
  }

  function renderPreview(messages) {
    $('#series-preview-title').textContent = `Review ${messages.length} ${messages.length === 1 ? 'message' : 'messages'} for b4 relay`;
    $('#series-preview').innerHTML = messages.map((message, i) => {
      const boundary = message.raw.indexOf('\n\n');
      const headers = message.raw.slice(0, boundary);
      const body = message.raw.slice(boundary + 2);
      const addresses = headers.match(/^(?:From|To|Cc|In-Reply-To):.*(?:\n[ \t].*)*/gm) || [];
      return `<details class="series-message-preview"${i === 0 ? ' open' : ''}>
        <summary>${escape(message.subject)} <span class="muted">${escape(message.filename)}</span></summary>
        <div class="series-addresses">${addresses.map(line => `<div>${escape(line.replace(/\n[ \t]+/g, ' '))}</div>`).join('')}</div>
        <pre class="mail-body">${styledBody(body)}</pre>
        <details><summary>Full message headers</summary><pre class="series-headers">${escape(headers)}</pre></details>
      </details>`;
    }).join('');
  }

  loadForm.addEventListener('submit', event => {
    event.preventDefault();
    run(editStatus, 'Reading local patches…', async () => {
      draft = await api('/api/patch-series/load', {
        method: 'POST', body: JSON.stringify({ path: $('#series-path').value.trim() })
      });
      preview = null;
      attempted = false;
      $('#series-to').value = '';
      $('#series-cc').value = '';
      selector.replaceChildren(...draft.messages.map(({ subject }, i) => new Option(subject, i)));
      editForm.hidden = false;
      showMessage(0);
      const missing = draft.messages.some(message => !message.to.trim());
      status(editStatus, missing ? 'Add a To address to any message without one, or enter a shared To address above.' : '');
    });
  });

  selector.addEventListener('change', () => showMessage(Number(selector.value)));
  for (const field of draftFields) {
    $(`#series-message-${field}`).addEventListener('input', event => {
      draft.messages[selected][field] = event.target.value;
      if (field === 'subject') selector.options[selected].textContent = event.target.value;
    });
  }

  editForm.addEventListener('submit', event => {
    event.preventDefault();
    if (!draft || attempted) return;
    run(editStatus, 'Preparing the outgoing messages…', async () => {
      const allTo = $('#series-to').value, allCc = $('#series-cc').value;
      const messages = draft.messages.map(({ to, cc, subject, body }) => ({
        to: applyRecipients(to, allTo), cc: applyRecipients(cc, allCc), subject, body
      }));
      preview = await api('/api/patch-series/preview', {
        method: 'POST', body: JSON.stringify({ id: draft.id, messages })
      });
      renderPreview(preview.messages);
      send.textContent = `Send ${preview.messages.length === 1 ? 'message' : 'series'} through b4 relay`;
      status(editStatus, '');
      status(sendStatus, '');
      $('#back-to-patches').textContent = 'Keep editing';
      previewDialog.showModal();
    }).then(() => { if (previewDialog.open) $('#back-to-patches').focus(); });
  });

  send.addEventListener('click', () => {
    if (!preview || attempted) return;
    run(sendStatus, 'Signing and submitting the reviewed messages…', async () => {
      attempted = true;
      const result = await api('/api/patch-series/send', {
        method: 'POST', body: JSON.stringify({ id: preview.id })
      });
      const root = preview.messages[0].messageId.slice(1, -1);
      const link = document.createElement('a');
      link.href = `https://lore.kernel.org/r/${encodeURIComponent(root)}`;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = 'Find on lore';
      status(sendStatus, `Relay accepted ${result.count} ${result.count === 1 ? 'message' : 'messages'}. `);
      sendStatus.append(link);
      status(editStatus, 'Relay submission accepted. Load a patch file or directory to start a new draft.');
      $('#back-to-patches').textContent = 'Done';
    }).then(() => {
      if (sendStatus.classList.contains('error')) {
        status(editStatus, sendStatus.textContent, true);
        $('#back-to-patches').textContent = 'Back to patches';
      }
    });
  });

  for (const element of [dialog, previewDialog]) {
    element.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
  }
  $('#close-patch-series').addEventListener('click', () => dialog.close());
  for (const button of [$('#close-series-preview'), $('#back-to-patches')]) {
    button.addEventListener('click', () => previewDialog.close());
  }
  return {
    open() {
      if (dialog.open) return;
      dialog.showModal();
      editor.refresh();
    }
  };
}
