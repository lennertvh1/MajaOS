'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
require('../public/search.js');
const { tokens, itemScore, rankHits } = globalThis.TB_search;

test('tokens split on spaces', () => {
  assert.deepEqual(tokens('  Jelly Fin '), ['jelly', 'fin']);
  assert.deepEqual(tokens(''), []);
});

test('all tokens must match', () => {
  const it = { title: 'Home Assistant', keys: ['homeassistant', 'hass'] };
  assert.equal(itemScore(it, ['home']), 1);
  assert.equal(itemScore(it, ['home', 'assistant']), 3);
  assert.equal(itemScore(it, ['home', 'xyz']), 9);
});

test('a long query stays searchable when every token matches', () => {
  const it = { id: 'device', group: 'hardware', title: 'Realtek network adapter', keys: ['RTL8125', 'r8169', 'PCI'] };
  assert.deepEqual(rankHits([it], 'realtek r8169 pci').map((x) => x.id), ['device']);
  assert.deepEqual(rankHits([it], 'realtek missing pci'), []);
});

test('exact title beats a word in the middle', () => {
  const items = [
    { id: 'a', group: 'apps', title: 'Notes', keys: [] },
    { id: 'b', group: 'apps', title: 'Jellyfin Notes', keys: [] },
  ];
  assert.deepEqual(rankHits(items, 'notes').map((x) => x.id), ['a', 'b']);
});

test('caps hits per group and overall', () => {
  const items = [];
  for (let i = 0; i < 8; i++) items.push({ id: 'a' + i, group: 'apps', title: 'plex ' + i, keys: [] });
  for (let i = 0; i < 8; i++) items.push({ id: 'v' + i, group: 'vms', title: 'plex vm ' + i, keys: [] });
  const hits = rankHits(items, 'plex', { perGroup: 2, limit: 3 });
  assert.equal(hits.filter((x) => x.group === 'apps').length, 2);
  assert.equal(hits.length, 3);
});

test('groups keep their order: apps before the app store', () => {
  const items = [
    { id: 's', group: 'store', title: 'Plex', keys: [] },
    { id: 'a', group: 'apps', title: 'Plex', keys: [] },
  ];
  assert.deepEqual(rankHits(items, 'plex').map((x) => x.id), ['a', 's']);
});
