const defaults = [
  { name: 'linux-kernel', address: 'linux-kernel.vger.kernel.org', url: 'https://lore.kernel.org/lkml/' },
  { name: 'linux-mm', address: 'linux-mm.kvack.org', url: 'https://lore.kernel.org/linux-mm/' },
  { name: 'linux-fsdevel', address: 'linux-fsdevel.vger.kernel.org', url: 'https://lore.kernel.org/linux-fsdevel/' },
  { name: 'netdev', address: 'netdev.vger.kernel.org', url: 'https://lore.kernel.org/netdev/' },
  { name: 'linux-btrfs', address: 'linux-btrfs.vger.kernel.org', url: 'https://lore.kernel.org/linux-btrfs/' }
];

export function archiveUrl(value) {
  try {
    const url = new URL(value);
    if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) return url.href;
  } catch { /* invalid URL */ }
  return '';
}

export function restoreLists(stored) {
  if (!Array.isArray(stored) || !stored.every(list => typeof list?.name === 'string' && typeof list.address === 'string')) {
    return defaults.map(list => ({ ...list }));
  }
  return stored.map(({ name, address, url }) => ({
    name, address, url: archiveUrl(url) || defaults.find(list => list.address === address)?.url || ''
  }));
}

export function sameArchive(first, second) {
  if (!first || !second) return false;
  const a = new URL(first), b = new URL(second);
  return a.origin === b.origin && a.pathname.replace(/\/$/, '') === b.pathname.replace(/\/$/, '') &&
    a.search === b.search && a.hash === b.hash;
}

export function isLoreMessageUrl(value) {
  try {
    const url = new URL(value);
    if (url.origin !== 'https://lore.kernel.org' || url.username || url.password) return false;
    const [list, id, view, ...rest] = url.pathname.split('/').filter(Boolean);
    if (!/^[\w-]+$/.test(list || '') || !id || rest.length || (view && !['t', 'T', 'raw', 't.mbox.gz'].includes(view))) return false;
    const messageId = decodeURIComponent(id);
    return messageId.includes('@') && !/[\s<>\x00-\x1f\x7f]/.test(messageId) && messageId.length <= 998;
  } catch { return false; }
}
