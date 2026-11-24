import test from 'node:test';
import assert from 'node:assert/strict';
import { archiveUrl, isLoreMessageUrl, restoreLists, sameArchive } from '../public/lists.js';

test('old list preferences retain their mailbox filters and gain known archive URLs', () => {
  const old = [
    { name: 'Kernel', address: 'linux-kernel.vger.kernel.org' },
    { name: 'My list', address: 'my-list@example.org' }
  ];
  assert.deepEqual(restoreLists(old), [
    { ...old[0], url: 'https://lore.kernel.org/lkml/' },
    { ...old[1], url: '' }
  ]);
  assert.deepEqual(restoreLists([]), []);
  assert.equal(restoreLists(null).length, 5);
});

test('archive links are HTTP(S) and lore cross-references point to messages', () => {
  assert.equal(archiveUrl('https://archives.example.org'), 'https://archives.example.org/');
  assert.equal(archiveUrl('https://user@example.org'), '');
  assert.equal(archiveUrl('javascript:alert(1)'), '');
  assert.equal(sameArchive('https://lore.kernel.org/lkml', 'https://lore.kernel.org/lkml/'), true);
  assert.equal(isLoreMessageUrl('https://lore.kernel.org/r/patch%40example.org'), true);
  assert.equal(isLoreMessageUrl('https://lore.kernel.org/lkml/patch@example.org/T/'), true);
  assert.equal(isLoreMessageUrl('https://lore.kernel.org/lkml/'), false);
  assert.equal(isLoreMessageUrl('https://lore.kernel.org.example.org/lkml/patch@example.org/'), false);
});
