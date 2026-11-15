/**
 * A QR code, as a matrix of true/false.
 *
 * Written here rather than pulled in as a dependency because what the
 * warehouse encodes is an item code — a dozen or so characters of ASCII, in
 * one fixed mode, at one fixed error-correction level. A general QR library
 * is forty kilobytes of modes this will never use, and this is the part of
 * the spec that is short enough to be read and checked.
 *
 * Byte mode, error correction level M, versions 1 to 10 — which covers up to
 * 213 characters, and an item code is thirteen.
 *
 * The specification is ISO/IEC 18004. The pieces below follow it in order:
 * encode the data, add error-correction codewords, lay them out on the grid,
 * then pick the mask that makes the result easiest for a scanner to read.
 */

/** How many data codewords fit at level M, by version (index = version). */
const DATA_CODEWORDS_M = [0, 16, 28, 44, 64, 86, 108, 124, 154, 182, 216];

/** Error-correction codewords per block at level M, by version. */
const EC_PER_BLOCK_M = [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26];

/** How many blocks the data is split into at level M, by version. */
const BLOCKS_M = [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5];

/** Where the alignment patterns go, by version. */
const ALIGNMENT = [
  [], [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34],
  [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50],
];

/* The log and antilog tables for GF(256), which is the field the
   error-correction arithmetic happens in. Built once. */
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d; // the field's generator polynomial
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

const mul = (a: number, b: number) =>
  (a === 0 || b === 0) ? 0 : EXP[LOG[a] + LOG[b]];

/** The generator polynomial for `n` error-correction codewords. */
function generator(n: number): number[] {
  let poly = [1];
  for (let i = 0; i < n; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= mul(poly[j], EXP[i]);
    }
    poly = next;
  }
  return poly;
}

/** The error-correction codewords for one block. */
function ecBlock(data: number[], count: number): number[] {
  const gen = generator(count);
  const buf = [...data, ...new Array(count).fill(0)];

  for (let i = 0; i < data.length; i++) {
    const lead = buf[i];
    if (!lead) continue;
    for (let j = 0; j < gen.length; j++) {
      buf[i + j] ^= mul(gen[j], lead);
    }
  }

  return buf.slice(data.length);
}

/**
 * The smallest version that fits this much data.
 *
 * Four bits of mode, eight or sixteen of length, then the bytes themselves,
 * plus four bits to terminate.
 */
function versionFor(bytes: number): number {
  for (let v = 1; v <= 10; v++) {
    const lengthBits = v < 10 ? 8 : 16;
    const needed = Math.ceil((4 + lengthBits + bytes * 8 + 4) / 8);
    if (needed <= DATA_CODEWORDS_M[v]) return v;
  }
  throw new Error('that is too long for a label');
}

/** The data codewords: mode, length, the bytes, then padding. */
function encode(text: string, version: number): number[] {
  const bytes: number[] = [];
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    /* Everything a label carries is ASCII. Anything else is replaced rather
       than silently mangled into a code that scans as something different. */
    bytes.push(code < 128 ? code : 63); // '?'
  }

  const bits: number[] = [];
  const push = (value: number, length: number) => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >> i) & 1);
  };

  push(0b0100, 4);                              // byte mode
  push(bytes.length, version < 10 ? 8 : 16);    // how many
  for (const b of bytes) push(b, 8);

  const capacity = DATA_CODEWORDS_M[version] * 8;
  push(0, Math.min(4, capacity - bits.length)); // terminator
  while (bits.length % 8) bits.push(0);

  const words: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    words.push(bits.slice(i, i + 8).reduce((n, b) => (n << 1) | b, 0));
  }

  /* The two pad bytes the specification names, alternating. */
  const pad = [0xec, 0x11];
  for (let i = 0; words.length < DATA_CODEWORDS_M[version]; i++) {
    words.push(pad[i % 2]);
  }

  return words;
}

/** Data and error-correction codewords, interleaved as the format requires. */
function interleave(data: number[], version: number): number[] {
  const blocks = BLOCKS_M[version];
  const ecCount = EC_PER_BLOCK_M[version];
  const per = Math.floor(data.length / blocks);
  const longer = data.length % blocks;

  const dataBlocks: number[][] = [];
  const ecBlocks: number[][] = [];
  let at = 0;

  for (let i = 0; i < blocks; i++) {
    const size = per + (i >= blocks - longer ? 1 : 0);
    const block = data.slice(at, at + size);
    at += size;
    dataBlocks.push(block);
    ecBlocks.push(ecBlock(block, ecCount));
  }

  const out: number[] = [];
  const widest = Math.max(...dataBlocks.map((b) => b.length));
  for (let i = 0; i < widest; i++) {
    for (const b of dataBlocks) if (i < b.length) out.push(b[i]);
  }
  for (let i = 0; i < ecCount; i++) {
    for (const b of ecBlocks) out.push(b[i]);
  }

  return out;
}

/** The three finder squares, the timing lines, and the alignment patterns. */
function addPatterns(grid: (boolean | null)[][], size: number, version: number) {
  const finder = (row: number, col: number) => {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const rr = row + r, cc = col + c;
        if (rr < 0 || rr >= size || cc < 0 || cc >= size) continue;
        const on = r >= 0 && r <= 6 && (c === 0 || c === 6)
          || c >= 0 && c <= 6 && (r === 0 || r === 6)
          || r >= 2 && r <= 4 && c >= 2 && c <= 4;
        grid[rr][cc] = on;
      }
    }
  };

  finder(0, 0); finder(0, size - 7); finder(size - 7, 0);

  for (let i = 8; i < size - 8; i++) {
    grid[6][i] = i % 2 === 0;
    grid[i][6] = i % 2 === 0;
  }

  for (const r of ALIGNMENT[version]) {
    for (const c of ALIGNMENT[version]) {
      /* Not where a finder already is. */
      if ((r < 9 && c < 9) || (r < 9 && c > size - 10)
          || (r > size - 10 && c < 9)) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          grid[r + dr][c + dc] =
            Math.max(Math.abs(dr), Math.abs(dc)) !== 1;
        }
      }
    }
  }

  /* Always dark, by definition. */
  grid[size - 8][8] = true;
}

/** The format information: level M, the mask, and its BCH check bits. */
function addFormat(grid: (boolean | null)[][], size: number, mask: number) {
  const value = (0b00 << 3) | mask; // 00 is level M
  let bits = value << 10;
  for (let i = 4; i >= 0; i--) {
    if (bits & (1 << (i + 10))) bits ^= 0b10100110111 << i;
  }
  const format = ((value << 10) | bits) ^ 0b101010000010010;

  for (let i = 0; i < 15; i++) {
    const on = ((format >> i) & 1) === 1;
    /* Written twice, in two places, so a damaged corner does not make the
       code unreadable. */
    if (i < 6) grid[i][8] = on;
    else if (i < 8) grid[i + 1][8] = on;
    else if (i === 8) grid[8][7] = on;
    else grid[8][14 - i] = on;

    if (i < 8) grid[8][size - 1 - i] = on;
    else grid[size - 15 + i][8] = on;
  }
}

/** The mask patterns, by number. */
const MASKS = [
  (r: number, c: number) => (r + c) % 2 === 0,
  (r: number) => r % 2 === 0,
  (_r: number, c: number) => c % 3 === 0,
  (r: number, c: number) => (r + c) % 3 === 0,
  (r: number, c: number) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r: number, c: number) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r: number, c: number) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r: number, c: number) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

/**
 * How hard this grid is for a scanner to read.
 *
 * Lower is better. The four rules are the specification's: long runs of one
 * colour, solid blocks, patterns that look like a finder square, and an
 * unbalanced ratio of dark to light.
 */
function penalty(grid: boolean[][], size: number): number {
  let score = 0;

  const run = (get: (i: number, j: number) => boolean) => {
    for (let i = 0; i < size; i++) {
      let same = 1;
      for (let j = 1; j < size; j++) {
        if (get(i, j) === get(i, j - 1)) {
          same++;
        } else {
          if (same >= 5) score += same - 2;
          same = 1;
        }
      }
      if (same >= 5) score += same - 2;
    }
  };
  run((i, j) => grid[i][j]);
  run((i, j) => grid[j][i]);

  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const v = grid[r][c];
      if (v === grid[r][c + 1] && v === grid[r + 1][c] && v === grid[r + 1][c + 1]) {
        score += 3;
      }
    }
  }

  const finderish = [true, false, true, true, true, false, true, false, false, false, false];
  const check = (get: (i: number) => boolean, len: number) => {
    for (let i = 0; i + finderish.length <= len; i++) {
      let hit = true;
      for (let j = 0; j < finderish.length; j++) {
        if (get(i + j) !== finderish[j]) { hit = false; break; }
      }
      if (hit) score += 40;
    }
  };
  for (let i = 0; i < size; i++) {
    check((j) => grid[i][j], size);
    check((j) => grid[j][i], size);
  }

  let dark = 0;
  for (const row of grid) for (const v of row) if (v) dark++;
  const percent = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(percent - 50) / 5) * 10;

  return score;
}

/**
 * A QR code for `text`, as rows of true (dark) and false (light).
 *
 * Every mask is tried and the least penalised wins, which is what the
 * specification asks for and what makes a code read reliably on a cheap
 * scanner under warehouse lighting.
 */
export function qrMatrix(text: string): boolean[][] {
  const bytes = [...text].length;
  const version = versionFor(bytes);
  const size = version * 4 + 17;

  const codewords = interleave(encode(text, version), version);

  /* null means "nothing has been placed here yet", which is what tells the
     layout where data may go. */
  const base: (boolean | null)[][] =
    Array.from({ length: size }, () => new Array(size).fill(null));
  addPatterns(base, size, version);

  /* Reserve the format areas so data does not land on them. */
  for (let i = 0; i < 9; i++) {
    if (base[8][i] === null) base[8][i] = false;
    if (base[i][8] === null) base[i][8] = false;
  }
  for (let i = 0; i < 8; i++) {
    if (base[8][size - 1 - i] === null) base[8][size - 1 - i] = false;
    if (base[size - 1 - i][8] === null) base[size - 1 - i][8] = false;
  }

  /* The data snakes up and down in two-column strips, right to left. */
  const free: [number, number][] = [];
  let up = true;
  for (let c = size - 1; c > 0; c -= 2) {
    if (c === 6) c--; // the timing column is not part of the path
    for (let i = 0; i < size; i++) {
      const r = up ? size - 1 - i : i;
      for (const cc of [c, c - 1]) {
        if (base[r][cc] === null) free.push([r, cc]);
      }
    }
    up = !up;
  }

  const bits: boolean[] = [];
  for (const w of codewords) {
    for (let i = 7; i >= 0; i--) bits.push(((w >> i) & 1) === 1);
  }

  let best: boolean[][] | null = null;
  let bestScore = Infinity;

  for (let mask = 0; mask < 8; mask++) {
    const grid = base.map((row) => [...row]);
    free.forEach(([r, c], i) => {
      const bit = i < bits.length ? bits[i] : false;
      grid[r][c] = MASKS[mask](r, c) ? !bit : bit;
    });
    addFormat(grid, size, mask);

    const solid = grid.map((row) => row.map((v) => v === true));
    const score = penalty(solid, size);
    if (score < bestScore) { bestScore = score; best = solid; }
  }

  return best!;
}

/**
 * The same code as an SVG path, for printing.
 *
 * One path rather than a rectangle per module: a label sheet can hold sixty
 * codes, and sixty times six hundred rectangles is a document the browser
 * takes seconds to lay out.
 */
export function qrPath(text: string): { path: string; size: number } {
  const grid = qrMatrix(text);
  const parts: string[] = [];

  grid.forEach((row, r) => {
    let start = -1;
    row.forEach((on, c) => {
      if (on && start < 0) start = c;
      if (!on && start >= 0) { parts.push(`M${start} ${r}h${c - start}v1h${start - c}z`); start = -1; }
    });
    if (start >= 0) parts.push(`M${start} ${r}h${row.length - start}v1h${start - row.length}z`);
  });

  return { path: parts.join(''), size: grid.length };
}