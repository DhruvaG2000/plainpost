const CodeMirror = globalThis.CodeMirror;

function fileLanguage(path) {
  if (/\.[ch](?:\s|"|$)/i.test(path)) return 'c';
  if (/\.py(?:\s|"|$)/i.test(path)) return 'python';
  return '';
}

CodeMirror.defineMode('plainpost-mail', (config, { format }) => {
  const modes = {
    c: CodeMirror.getMode(config, 'text/x-csrc'),
    python: CodeMirror.getMode(config, 'text/x-python')
  };
  const forcedLanguage = modes[format] ? format : '';
  const startState = () => ({ depth: 0, fence: null, diff: false, hunk: null, oldLanguage: '', newLanguage: '', code: {} });

  function startLine(state, source) {
    const quote = source.match(/^(?:>[ \t]?)*/)[0];
    const depth = quote.replace(/[^>]/g, '').length;
    const text = source.slice(quote.length);
    if (depth !== state.depth) Object.assign(state, startState(), { depth });
    const line = { quote: quote.length, offset: quote.length, language: forcedLanguage, style: '', side: 'code' };
    const fence = text.match(/^\s*`{3,}\s*([\w+-]*)\s*$/);
    if (format !== 'diff' && fence) {
      const language = { c: 'c', python: 'python', py: 'python' }[fence[1].toLowerCase()] || '';
      state.fence = state.fence === null ? language : null;
      state.code = {};
      return { ...line, language: '', style: 'diff-meta' };
    }
    if (state.fence !== null) return { ...line, language: state.fence };

    const hunk = text.match(/^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/);
    if (hunk) {
      state.hunk = { old: Number(hunk[1] ?? 1), new: Number(hunk[2] ?? 1) };
      state.code = {};
      state.diff = true;
      return { ...line, language: '', style: 'diff-meta' };
    }
    const marker = text[0];
    const oldLine = state.hunk?.old > 0 && (marker === '-' || marker === ' ');
    const newLine = state.hunk?.new > 0 && (marker === '+' || marker === ' ');
    if (oldLine || newLine) {
      if (oldLine) state.hunk.old--;
      if (newLine) state.hunk.new--;
      const side = oldLine && !newLine ? 'old' : 'new';
      return { ...line, offset: quote.length + 1, side, context: oldLine && newLine,
        language: forcedLanguage || state[side + 'Language'],
        style: marker === '+' ? 'diff-add' : marker === '-' ? 'diff-remove' : '' };
    }

    if (/^diff --git /.test(text)) {
      Object.assign(state, { diff: true, hunk: null, code: {}, oldLanguage: '', newLanguage: '' });
    }
    const header = text.match(/^(---|\+\+\+)\s+(\S.*)$/);
    if (header) {
      state.diff = true;
      state[header[1] === '---' ? 'oldLanguage' : 'newLanguage'] = fileLanguage(header[2]);
    }
    if (header || (state.diff && /^(diff --git |index |(?:new|deleted) file mode |(?:old|new) mode |similarity index |(?:rename|copy) (?:from|to) |\\ No newline )/.test(text))) {
      return { ...line, language: '', style: 'diff-meta' };
    }
    if (format === 'diff' && /^[+-]/.test(text) && text !== '-- ') {
      return { ...line, offset: quote.length + 1, style: marker === '+' ? 'diff-add' : 'diff-remove' };
    }
    return line;
  }

  function innerToken(stream, state, line, side, language) {
    const mode = modes[language];
    state.code[side] ??= CodeMirror.startState(mode);
    return stream.hideFirstChars(line.offset, () => mode.token(stream, state.code[side]));
  }

  return {
    startState,
    copyState(state) {
      const code = {};
      for (const [side, value] of Object.entries(state.code)) {
        const language = side === 'code' ? state.fence ?? forcedLanguage : forcedLanguage || state[side + 'Language'];
        if (modes[language]) code[side] = CodeMirror.copyState(modes[language], value);
      }
      return { ...state, hunk: state.hunk && { ...state.hunk }, code };
    },
    token(stream, state) {
      if (stream.sol()) state.line = startLine(state, stream.string);
      const line = state.line;
      if (stream.pos < line.quote) { stream.pos = line.quote; return 'mail-quote'; }
      if (stream.pos < line.offset) { stream.pos = line.offset; return line.style; }
      if (line.context && stream.pos === line.offset && (forcedLanguage || state.oldLanguage)) {
        const old = new CodeMirror.StringStream(stream.string, config.tabSize);
        old.pos = old.start = line.offset;
        while (!old.eol()) {
          innerToken(old, state, line, 'old', forcedLanguage || state.oldLanguage);
          if (old.pos === old.start) old.next();
          old.start = old.pos;
        }
      }
      if (!line.language) { stream.skipToEnd(); return line.style || (line.quote ? 'mail-quote' : null); }
      const syntax = innerToken(stream, state, line, line.side, line.language);
      return [line.style && line.style + '-code', syntax].filter(Boolean).join(' ') || null;
    }
  };
});

export function mountComposer(textarea, { change, review, highlight, vim, vimStatus }) {
  function setHighlight() {
    editor.setOption('mode', highlight.value === 'plain' ? null : { name: 'plainpost-mail', format: highlight.value });
  }

  const editor = CodeMirror.fromTextArea(textarea, {
    tabSize: 8,
    screenReaderLabel: 'Plain-text message body',
    extraKeys: {
      'Ctrl-Enter': review,
      'Cmd-Enter': review,
      'Shift-Tab': false,
      Tab(cm) {
        if (cm.getOption('keyMap') === 'vim' && !cm.state.vim?.insertMode) return CodeMirror.Pass;
        cm.replaceSelection('\t', 'end', '+input');
      }
    }
  });
  textarea.required = false;
  const wrapper = editor.getWrapperElement();
  wrapper.addEventListener('keydown', event => {
    if (event.key === 'Escape' && vim.checked) event.preventDefault();
  });
  editor.on('change', change);
  editor.on('vim-mode-change', ({ mode }) => { vimStatus.textContent = mode; });
  function setVim() {
    vim.checked = localStorage.getItem('plainpost-vim') === 'true';
    if (vim.checked !== editor.getOption('vimMode')) {
      editor.setOption('vimMode', vim.checked);
      vimStatus.textContent = vim.checked ? 'normal' : '';
    }
  }
  vim.addEventListener('change', () => {
    localStorage.setItem('plainpost-vim', String(vim.checked));
    window.dispatchEvent(new Event('plainpost-vim-change'));
  });
  window.addEventListener('plainpost-vim-change', setVim);
  highlight.addEventListener('change', setHighlight);
  setVim();
  setHighlight();
  return editor;
}
