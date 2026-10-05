/**
 * Геометрия бумажного бланка (A4, 794×1123 CSS-пикселей). Одна и та же геометрия используется
 * при печати бланка (SVG) и при распознавании (OMR) — поэтому сканер и принтер должны сохранять 4 угловых маркера.
 */
export const PAGE = { w: 794, h: 1123 } as const;
export const MARKER_SIZE = 28;
/** Центры угловых маркеров: левый верхний, правый верхний, левый нижний, правый нижний */
export const MARKERS = [
  { cx: 44, cy: 44 }, { cx: 750, cy: 44 }, { cx: 44, cy: 1079 }, { cx: 750, cy: 1079 },
] as const;
export const BUBBLE_R = 10;
export const ROWS_PER_COL = 13;
export const QUESTIONS = 25;
const COL_X = [150, 510] as const;
const PITCH_X = 40;
const FIRST_Y = 320;
const PITCH_Y = 58;

export function bubbleCenter(position: number, idx: number): { x: number; y: number } {
  const col = position <= ROWS_PER_COL ? 0 : 1;
  const row = (position - 1) % ROWS_PER_COL;
  return { x: COL_X[col] + idx * PITCH_X, y: FIRST_Y + row * PITCH_Y };
}

export interface SheetLabels { title: string; subject: string; studentName: string; studentId: string; groupName: string; examId: string; sheetCode: string; kind: string }

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

/** SVG бланка. fills — для тестов: какие кружки закрасить (по позиции) */
export function sheetSvg(l: SheetLabels, fills: Array<number[] | undefined> = [], opts: { noise?: boolean } = {}): string {
  const parts: string[] = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${PAGE.w} ${PAGE.h}" width="${PAGE.w}" height="${PAGE.h}" font-family="Arial, Helvetica, sans-serif">`);
  parts.push(`<rect width="${PAGE.w}" height="${PAGE.h}" fill="#fff"/>`);
  for (const m of MARKERS) parts.push(`<rect x="${m.cx - MARKER_SIZE / 2}" y="${m.cy - MARKER_SIZE / 2}" width="${MARKER_SIZE}" height="${MARKER_SIZE}" fill="#000"/>`);
  parts.push(`<text x="${PAGE.w / 2}" y="100" text-anchor="middle" font-size="22" font-weight="700">${esc(l.title)}</text>`);
  parts.push(`<text x="90" y="145" font-size="14">Subject: <tspan font-weight="700">${esc(l.subject)}</tspan></text>`);
  parts.push(`<text x="90" y="170" font-size="14">Student: <tspan font-weight="700">${esc(l.studentName)}</tspan> · ID: <tspan font-weight="700">${esc(l.studentId)}</tspan> · Group: ${esc(l.groupName)}</text>`);
  parts.push(`<text x="90" y="195" font-size="14">Exam ID: <tspan font-family="monospace">${esc(l.examId)}</tspan> · ${esc(l.kind)} · Sheet: <tspan font-family="monospace" font-weight="700">${esc(l.sheetCode)}</tspan></text>`);
  parts.push(`<text x="90" y="235" font-size="12" fill="#444">Fill ONE circle per question completely with a black or blue pen. Leave all circles empty to skip the question. Do not mark outside the circles.</text>`);
  parts.push(`<line x1="90" y1="248" x2="704" y2="248" stroke="#999"/>`);
  for (let col = 0; col < 2; col++) {
    for (let i = 0; i < 5; i++) {
      const x = [150, 510][col] + i * PITCH_X;
      parts.push(`<text x="${x}" y="290" text-anchor="middle" font-size="13" font-weight="700">${'ABCDE'[i]}</text>`);
    }
  }
  for (let p = 1; p <= QUESTIONS; p++) {
    const { x, y } = bubbleCenter(p, 0);
    parts.push(`<text x="${x - 48}" y="${y + 5}" text-anchor="end" font-size="14" font-weight="700">${p}</text>`);
    for (let i = 0; i < 5; i++) {
      const c = bubbleCenter(p, i);
      const filled = fills[p - 1]?.includes(i);
      parts.push(`<circle cx="${c.x}" cy="${c.y}" r="${BUBBLE_R}" fill="${filled ? '#111' : 'none'}" stroke="#222" stroke-width="1.5"/>`);
    }
  }
  if (opts.noise) parts.push(`<rect x="300" y="1000" width="200" height="3" fill="#888"/>`);
  parts.push('</svg>');
  return parts.join('');
}
