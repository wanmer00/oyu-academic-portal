import sharp from 'sharp';
import { BUBBLE_R, MARKERS, QUESTIONS, bubbleCenter } from './omr.layout';

/**
 * OMR: распознавание закрашенных кружков (не рукописного текста).
 * 1) изображение приводится к серому и фиксированной ширине; 2) по 4 угловым маркерам находится проективное преобразование
 * «геометрия бланка → скан»; 3) измеряется затемнённость внутри каждого кружка; 4) решение по порогу относительно фона бланка.
 */
export interface OmrQuestion {
  position: number;
  /** индексы закрашенных кружков 0..4 */
  filled: number[];
  darkness: number[];
  flags: Array<'DOUBLE' | 'EMPTY' | 'LOW_CONFIDENCE'>;
  confidence: number;
}
export interface OmrResult {
  ok: boolean;
  error?: 'MARKERS_NOT_FOUND' | 'IMAGE_UNREADABLE';
  /** 0..1: доля вопросов, распознанных однозначно */
  quality: number;
  threshold: number;
  questions: OmrQuestion[];
}

const WIDTH = 1200;

function otsu(g: Uint8Array): number {
  const h = new Array(256).fill(0);
  for (let i = 0; i < g.length; i++) h[g[i]]++;
  const total = g.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * h[i];
  let sB = 0, wB = 0, best = 0, thr = 128;
  for (let t = 0; t < 256; t++) {
    wB += h[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sB += t * h[t];
    const between = wB * wF * ((sB / wB - (sum - sB) / wF) ** 2);
    if (between > best) { best = between; thr = t; }
  }
  return thr;
}

/** Ищет квадратный тёмный маркер в окне угла (связные компоненты) */
function findMarker(g: Uint8Array, W: number, H: number, thr: number, corner: 0 | 1 | 2 | 3): { x: number; y: number } | null {
  const rw = Math.round(W * 0.3), rh = Math.round(H * 0.22);
  const x0 = corner % 2 === 0 ? 0 : W - rw, y0 = corner < 2 ? 0 : H - rh;
  const seen = new Uint8Array(rw * rh);
  const dark = (x: number, y: number) => g[(y0 + y) * W + (x0 + x)] < thr;
  let best: { x: number; y: number; area: number } | null = null;
  const stack: number[] = [];
  for (let sy = 0; sy < rh; sy++) for (let sx = 0; sx < rw; sx++) {
    const si = sy * rw + sx;
    if (seen[si] || !dark(sx, sy)) continue;
    let area = 0, minX = sx, maxX = sx, minY = sy, maxY = sy;
    stack.length = 0; stack.push(si); seen[si] = 1;
    while (stack.length) {
      const i = stack.pop()!;
      const x = i % rw, y = (i / rw) | 0;
      area++;
      if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= rw || ny >= rh) continue;
        const ni = ny * rw + nx;
        if (!seen[ni] && dark(nx, ny)) { seen[ni] = 1; stack.push(ni); }
      }
    }
    const bw = maxX - minX + 1, bh = maxY - minY + 1;
    const aspect = bw / bh, fill = area / (bw * bh);
    if (bw < W * 0.015 || bw > W * 0.09 || bh < W * 0.015 || bh > W * 0.09 || aspect < 0.65 || aspect > 1.55 || fill < 0.75) continue;
    if (!best || area > best.area) best = { x: x0 + (minX + maxX) / 2, y: y0 + (minY + maxY) / 2, area };
  }
  return best ? { x: best.x, y: best.y } : null;
}

/** Гомография 4 точки → 4 точки (решение 8×8 методом Гаусса) */
function homography(src: Array<[number, number]>, dst: Array<[number, number]>): number[] {
  const A: number[][] = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i], [u, v] = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
  }
  for (let c = 0; c < 8; c++) {
    let p = c;
    for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]];
    for (let r = 0; r < 8; r++) {
      if (r === c) continue;
      const f = A[r][c] / A[c][c];
      for (let k = c; k < 9; k++) A[r][k] -= f * A[c][k];
    }
  }
  return A.map((row, i) => row[8] / row[i]);
}
const apply = (h: number[], x: number, y: number): [number, number] => {
  const d = h[6] * x + h[7] * y + 1;
  return [(h[0] * x + h[1] * y + h[2]) / d, (h[3] * x + h[4] * y + h[5]) / d];
};

export async function readSheet(image: Buffer): Promise<OmrResult> {
  const fail = (error: OmrResult['error']): OmrResult => ({ ok: false, error, quality: 0, threshold: 0, questions: [] });
  let raw: { data: Buffer; info: { width: number; height: number } };
  try {
    raw = await sharp(image, { failOn: 'none' }).rotate().greyscale().normalise().resize({ width: WIDTH }).raw().toBuffer({ resolveWithObject: true }) as never;
  } catch { return fail('IMAGE_UNREADABLE'); }
  const W = raw.info.width, H = raw.info.height;
  const g = new Uint8Array(raw.data);
  const thr = Math.min(150, Math.max(80, otsu(g)));
  const found = ([0, 1, 2, 3] as const).map((c) => findMarker(g, W, H, thr, c));
  if (found.some((f) => !f)) return fail('MARKERS_NOT_FOUND');
  const hm = homography(MARKERS.map((m) => [m.cx, m.cy] as [number, number]), found.map((f) => [f!.x, f!.y] as [number, number]));
  const scale = Math.hypot(found[1]!.x - found[0]!.x, found[1]!.y - found[0]!.y) / Math.hypot(MARKERS[1].cx - MARKERS[0].cx, MARKERS[1].cy - MARKERS[0].cy);

  // уровень бумаги — 90-й перцентиль яркости
  const sample: number[] = [];
  for (let i = 0; i < g.length; i += 7) sample.push(g[i]);
  sample.sort((a, b) => a - b);
  const paper = Math.max(1, sample[Math.floor(sample.length * 0.9)]);

  const rIn = BUBBLE_R * 0.62 * scale;
  const darkness = (cx: number, cy: number): number => {
    let s = 0, n = 0;
    const r = Math.ceil(rIn);
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      if (dx * dx + dy * dy > rIn * rIn) continue;
      const x = Math.round(cx + dx), y = Math.round(cy + dy);
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      s += g[y * W + x]; n++;
    }
    return n ? Math.max(0, Math.min(1, (paper - s / n) / paper)) : 0;
  };
  const all: number[][] = [];
  for (let p = 1; p <= QUESTIONS; p++) {
    const row: number[] = [];
    for (let i = 0; i < 5; i++) { const c = bubbleCenter(p, i); const [x, y] = apply(hm, c.x, c.y); row.push(darkness(x, y)); }
    all.push(row);
  }
  const flat = all.flat().sort((a, b) => a - b);
  const baseline = flat[Math.floor(flat.length / 2)];
  const threshold = Math.max(0.18, baseline + 0.2);

  const questions: OmrQuestion[] = all.map((row, i) => {
    const filled = row.map((d, k) => (d > threshold ? k : -1)).filter((k) => k >= 0);
    const sorted = [...row].sort((a, b) => b - a);
    const flags: OmrQuestion['flags'] = [];
    let confidence = 1;
    if (filled.length >= 2) { flags.push('DOUBLE'); confidence = 0.2; }
    else if (filled.length === 1) {
      confidence = Math.min(1, (sorted[0] - threshold) / 0.35 + 0.3);
      if (sorted[0] < threshold + 0.08 || sorted[1] > threshold * 0.75) { flags.push('LOW_CONFIDENCE'); confidence = Math.min(confidence, 0.5); }
    } else {
      flags.push('EMPTY');
      if (sorted[0] > threshold * 0.65) { flags.push('LOW_CONFIDENCE'); confidence = 0.4; }
    }
    return { position: i + 1, filled, darkness: row, flags, confidence: Math.round(confidence * 1000) / 1000 };
  });
  const clean = questions.filter((q) => !q.flags.includes('DOUBLE') && !q.flags.includes('LOW_CONFIDENCE')).length;
  return { ok: true, quality: Math.round((clean / questions.length) * 1000) / 1000, threshold, questions };
}
