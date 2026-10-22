/*
 * Kleine QR-code-maker (byte-modus, foutcorrectie M, versie 1 tot 10: tot 213 tekens).
 * Genoeg voor een otpauth://-adres voor tweestapsverificatie. window.TBQR.svg(tekst) geeft een SVG terug.
 */
(function () {
  'use strict';
  // Per versie: [aantal blokken, datawoorden per blok] (groep 1 en eventueel groep 2) en foutcorrectiewoorden per blok, niveau M.
  const BLOCKS = [null,
    { ec: 10, g: [[1, 16]] }, { ec: 16, g: [[1, 28]] }, { ec: 26, g: [[1, 44]] }, { ec: 18, g: [[2, 32]] }, { ec: 24, g: [[2, 43]] },
    { ec: 16, g: [[4, 27]] }, { ec: 18, g: [[4, 31]] }, { ec: 22, g: [[2, 38], [2, 39]] }, { ec: 22, g: [[3, 36], [2, 37]] }, { ec: 26, g: [[4, 43], [1, 44]] }];
  const ALIGN = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];
  const VERSION_INFO = { 7: 0x07c94, 8: 0x085bc, 9: 0x09a99, 10: 0x0a4d3 };

  /* ---- Galoisveld GF(256) met polynoom 0x11D, voor Reed-Solomon */
  const EXP = new Array(512), LOG = new Array(256);
  for (let i = 0, x = 1; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  const mul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);
  function generator(n) {
    let g = [1];
    for (let i = 0; i < n; i++) {
      const next = new Array(g.length + 1).fill(0);
      g.forEach((c, j) => { next[j] ^= c; next[j + 1] ^= mul(c, EXP[i]); });
      g = next;
    }
    return g;
  }
  function ecWords(data, n) {
    const g = generator(n), r = data.concat(new Array(n).fill(0));
    for (let i = 0; i < data.length; i++) {
      const f = r[i];
      if (f) for (let j = 0; j < g.length; j++) r[i + j] ^= mul(g[j], f);
    }
    return r.slice(data.length);
  }

  /* ---- gegevens → codewoorden */
  function codewords(bytes) {
    let v = 1;
    const dataCap = (ver) => BLOCKS[ver].g.reduce((s, [n, k]) => s + n * k, 0);
    for (; v <= 10; v++) if (4 + (v < 10 ? 8 : 16) + bytes.length * 8 <= dataCap(v) * 8) break;
    if (v > 10) throw new Error('Te veel tekst voor een QR-code');
    const cap = dataCap(v), bits = [];
    const put = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
    put(4, 4); put(bytes.length, v < 10 ? 8 : 16);
    bytes.forEach((b) => put(b, 8));
    put(0, Math.min(4, cap * 8 - bits.length));
    while (bits.length % 8) bits.push(0);
    const data = [];
    for (let i = 0; i < bits.length; i += 8) data.push(parseInt(bits.slice(i, i + 8).join(''), 2));
    for (let p = 0; data.length < cap; p++) data.push(p % 2 ? 0x11 : 0xec);
    // In blokken verdelen, foutcorrectie per blok, dan door elkaar (interleaving).
    const blocks = []; let at = 0;
    BLOCKS[v].g.forEach(([n, k]) => { for (let i = 0; i < n; i++) { blocks.push(data.slice(at, at + k)); at += k; } });
    const ecs = blocks.map((b) => ecWords(b, BLOCKS[v].ec));
    const out = [], maxK = Math.max(...blocks.map((b) => b.length));
    for (let i = 0; i < maxK; i++) blocks.forEach((b) => { if (i < b.length) out.push(b[i]); });
    for (let i = 0; i < BLOCKS[v].ec; i++) ecs.forEach((e) => out.push(e[i]));
    return { version: v, words: out };
  }

  /* ---- het raster */
  function build(version, words, mask) {
    const size = version * 4 + 17;
    const m = Array.from({ length: size }, () => new Array(size).fill(null)); // null = nog vrij
    const set = (r, c, val) => { if (r >= 0 && c >= 0 && r < size && c < size) m[r][c] = val; };
    const finder = (r, c) => {
      for (let i = -1; i <= 7; i++) for (let j = -1; j <= 7; j++) {
        const on = i >= 0 && i <= 6 && j >= 0 && j <= 6 && (i === 0 || i === 6 || j === 0 || j === 6 || (i >= 2 && i <= 4 && j >= 2 && j <= 4));
        set(r + i, c + j, on);
      }
    };
    finder(0, 0); finder(0, size - 7); finder(size - 7, 0);
    for (let i = 8; i < size - 8; i++) { m[6][i] = i % 2 === 0; m[i][6] = i % 2 === 0; } // tijdlijnen
    const al = ALIGN[version];
    const last = al[al.length - 1];
    for (const r of al) for (const c of al) {
      if ((r === 6 && c === 6) || (r === 6 && c === last) || (r === last && c === 6)) continue; // overlapt met een finder
      for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) m[r + i][c + j] = Math.max(Math.abs(i), Math.abs(j)) !== 1;
    }
    // Plaats voor formaat- (en versie-)informatie vrijhouden.
    for (let i = 0; i < 9; i++) { if (m[8][i] === null) m[8][i] = false; if (m[i][8] === null) m[i][8] = false; }
    for (let i = 0; i < 8; i++) { if (m[8][size - 1 - i] === null) m[8][size - 1 - i] = false; if (m[size - 1 - i][8] === null) m[size - 1 - i][8] = false; }
    m[size - 8][8] = true; // het donkere module
    if (version >= 7) for (let i = 0; i < 6; i++) for (let j = 0; j < 3; j++) { m[i][size - 11 + j] = false; m[size - 11 + j][i] = false; }
    const reserved = m.map((row) => row.map((x) => x !== null));
    // Gegevens zigzaggend van rechtsonder naar boven, twee kolommen tegelijk, kolom 6 overslaan.
    const bits = []; words.forEach((w) => { for (let i = 7; i >= 0; i--) bits.push((w >>> i) & 1); });
    let k = 0, up = true;
    for (let c = size - 1; c > 0; c -= 2) {
      if (c === 6) c--;
      for (let n = 0; n < size; n++) {
        const r = up ? size - 1 - n : n;
        for (let d = 0; d < 2; d++) {
          const cc = c - d;
          if (reserved[r][cc]) continue;
          const bit = k < bits.length ? bits[k++] === 1 : false;
          m[r][cc] = bit !== maskBit(mask, r, cc);
        }
      }
      up = !up;
    }
    // Formaatinformatie: niveau M (00) + masker, BCH(15,5), XOR 0x5412.
    let f = (0 << 3) | mask, rem = f << 10;
    for (let i = 14; i >= 10; i--) if ((rem >>> i) & 1) rem ^= 0x537 << (i - 10);
    const fmt = ((f << 10) | rem) ^ 0x5412;
    const fb = (i) => ((fmt >>> i) & 1) === 1;
    for (let i = 0; i <= 5; i++) m[8][i] = fb(14 - i);
    m[8][7] = fb(8); m[8][8] = fb(7); m[7][8] = fb(6);
    for (let i = 9; i <= 14; i++) m[14 - i][8] = fb(14 - i);
    for (let i = 0; i <= 7; i++) m[size - 1 - i][8] = fb(14 - i);
    for (let i = 8; i <= 14; i++) m[8][size - 15 + i] = fb(14 - i);
    if (version >= 7) {
      const vi = VERSION_INFO[version];
      for (let i = 0; i < 18; i++) { const b = ((vi >>> i) & 1) === 1; m[Math.floor(i / 3)][size - 11 + (i % 3)] = b; m[size - 11 + (i % 3)][Math.floor(i / 3)] = b; }
    }
    return m;
  }
  function maskBit(mask, r, c) {
    switch (mask) {
      case 0: return (r + c) % 2 === 0;
      case 1: return r % 2 === 0;
      case 2: return c % 3 === 0;
      case 3: return (r + c) % 3 === 0;
      case 4: return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
      case 5: return ((r * c) % 2) + ((r * c) % 3) === 0;
      case 6: return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0;
      default: return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0;
    }
  }
  // Strafpunten (de vier regels uit de norm): het masker met de minste punten is het best leesbaar.
  function penalty(m) {
    const n = m.length; let p = 0, dark = 0;
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
      if (m[r][c]) dark++;
      if (r < n - 1 && c < n - 1 && m[r][c] === m[r + 1][c] && m[r][c] === m[r][c + 1] && m[r][c] === m[r + 1][c + 1]) p += 3;
    }
    const line = (get) => {
      for (let i = 0; i < n; i++) {
        let run = 1;
        for (let j = 1; j <= n; j++) {
          if (j < n && get(i, j) === get(i, j - 1)) run++;
          else { if (run >= 5) p += run - 2; run = 1; }
        }
        for (let j = 0; j + 10 < n; j++) {
          const s = Array.from({ length: 11 }, (_, k) => (get(i, j + k) ? 1 : 0)).join('');
          if (s === '10111010000' || s === '00001011101') p += 40;
        }
      }
    };
    line((i, j) => m[i][j]); line((i, j) => m[j][i]);
    p += Math.floor(Math.abs(dark * 100 / (n * n) - 50) / 5) * 10;
    return p;
  }

  function matrix(text) {
    const bytes = [...new TextEncoder().encode(String(text))];
    const { version, words } = codewords(bytes);
    let best = null, bestP = Infinity;
    for (let mask = 0; mask < 8; mask++) { const m = build(version, words, mask), p = penalty(m); if (p < bestP) { best = m; bestP = p; } }
    return best;
  }
  // SVG met een witte rand van 4 modules (verplicht om te kunnen scannen).
  function svg(text, { size = 200 } = {}) {
    const m = matrix(text), n = m.length + 8;
    let d = '';
    m.forEach((row, r) => row.forEach((on, c) => { if (on) d += `M${c + 4} ${r + 4}h1v1h-1z`; }));
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" width="${size}" height="${size}" shape-rendering="crispEdges" role="img" aria-label="QR-code">` +
      `<rect width="${n}" height="${n}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
  }
  window.TBQR = { matrix, svg };
})();
