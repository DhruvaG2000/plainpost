// RFC message headers determine ancestry; dates only order siblings.
export function threadTree(messages) {
  const nodes = new Map(), ids = value => String(value || '').match(/<[^<>\s]+>/g) || [];
  const node = key => { if (!nodes.has(key)) nodes.set(key, { key, message: null, parent: null, children: [] }); return nodes.get(key); };
  for (const message of messages) {
    const key = ids(message.messageId)[0] || `local:${message.id}`;
    const current = node(key);
    if (!current.message) current.message = message;
  }
  for (const message of messages) {
    const current = node(ids(message.messageId)[0] || `local:${message.id}`);
    if (current.message !== message) continue;
    const refs = [...new Set(ids(message.references).slice(-40))].filter(id => id !== current.key);
    for (let i = 1; i < refs.length; i++) {
      const child = node(refs[i]);
      if (!child.parent && !child.message) child.parent = node(refs[i - 1]);
    }
    const parentId = ids(message.inReplyTo).at(-1) || refs.at(-1);
    if (parentId && parentId !== current.key) current.parent = node(parentId);
  }
  // Damaged archive headers must never produce an infinite traversal.
  const complete = new Set();
  for (const start of nodes.values()) {
    const seen = new Set(); let current = start;
    while (current && !complete.has(current)) {
      seen.add(current);
      if (seen.has(current.parent)) { current.parent = null; break; }
      current = current.parent;
    }
    for (const current of seen) complete.add(current);
  }
  for (const current of nodes.values()) if (current.parent) current.parent.children.push(current);
  const compare = (a, b) => (a.message?.date || 0) - (b.message?.date || 0);
  const roots = [...nodes.values()].filter(n => !n.parent).sort(compare), rows = [], stack = roots.map(n => ({ node: n, prefix: '', depth: 0, last: false })).reverse();
  while (stack.length) {
    const row = stack.pop(); rows.push(row);
    const children = row.node.children.sort(compare);
    for (let i = children.length - 1; i >= 0; i--) stack.push({ node: children[i], depth: row.depth + 1, last: i === children.length - 1, prefix: row.prefix + (row.depth ? (row.last ? '  ' : '| ') : '') });
  }
  return rows;
}
