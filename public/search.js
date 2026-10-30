/* Rank items for the header search (Spotlight-style). Tests load this file too. */
(function (root) {
  'use strict';
  function tokens(q) {
    return String(q || '').toLowerCase().trim().split(/\s+/).filter(Boolean);
  }
  function hayScore(hay, tok) {
    const h = String(hay || '').toLowerCase();
    if (!h || !tok) return 9;
    if (h === tok) return 0;
    if (h.startsWith(tok)) return 1;
    const i = h.indexOf(tok);
    if (i < 0) return 9;
    if (i > 0 && /[\s\-_/.:]/.test(h[i - 1])) return 2;
    return 3;
  }
  function itemScore(item, toks) {
    const fields = [item.title].concat(item.keys || []).map((x) => String(x == null ? '' : x));
    let total = 0;
    for (const tok of toks) {
      let best = 9;
      fields.forEach((f, i) => {
        const s = hayScore(f, tok);
        if (s === 9) return;
        best = Math.min(best, s + (i ? 1 : 0));
      });
      if (best >= 9) return 9;
      total += best;
    }
    // 9 means no match. Several valid tokens can otherwise add up to 9 and disappear.
    return Math.min(total, 8);
  }
  const GROUPS = { apps: 0, vms: 1, folders: 2, pages: 3, settings: 4, hardware: 5, shares: 6, backups: 7, store: 8, ai: 9, shortcuts: 10 };
  function rankHits(items, query, opts) {
    const toks = tokens(query);
    if (!toks.length) return [];
    const limit = (opts && opts.limit) || 14;
    const perGroup = (opts && opts.perGroup) || 5;
    const scored = items.map((it) => ({ it, s: itemScore(it, toks) })).filter((x) => x.s < 9);
    scored.sort((a, b) => (GROUPS[a.it.group] ?? 9) - (GROUPS[b.it.group] ?? 9)
      || a.s - b.s
      || (a.it.order || 0) - (b.it.order || 0)
      || String(a.it.title).localeCompare(String(b.it.title)));
    const n = Object.create(null);
    const out = [];
    for (const x of scored) {
      const g = x.it.group || '';
      n[g] = (n[g] || 0) + 1;
      if (n[g] > perGroup) continue;
      out.push(x.it);
      if (out.length >= limit) break;
    }
    return out;
  }
  root.TB_search = { tokens, hayScore, itemScore, rankHits, GROUPS };
})(typeof window !== 'undefined' ? window : globalThis);
