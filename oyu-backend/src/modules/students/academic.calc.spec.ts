import { describe, expect, it } from 'vitest';
import { standingFor, subjectOutcome, weightedGpa } from './academic.calc';

describe('subjectOutcome', () => {
  it('uses the official scale', () => {
    expect(subjectOutcome(92)).toEqual({ passed: true, letter: 'A', gradePoints: 4 });
    expect(subjectOutcome(72)).toEqual({ passed: true, letter: 'C', gradePoints: 2.7 });
  });
  it('pass mark is 51: 51..59 passes (E) and earns credits', () => {
    expect(subjectOutcome(51)).toEqual({ passed: true, letter: 'E', gradePoints: 1 });
    expect(subjectOutcome(55).passed).toBe(true);
  });
  it('below 51 → F, 0 points', () => {
    expect(subjectOutcome(50.99)).toEqual({ passed: false, letter: 'F', gradePoints: 0 });
  });
});

describe('weightedGpa', () => {
  it('weights by credits', () => {
    // 8 × 4.0 + 3 × 2.0 = 38 / 11 = 3.4545 → 3.45 (невзвешенное среднее дало бы 3.0)
    expect(weightedGpa([{ credits: 8, gradePoints: 4 }, { credits: 3, gradePoints: 2 }])).toBe(3.45);
  });
  it('a failed subject counts with 0 points', () => {
    expect(weightedGpa([{ credits: 8, gradePoints: 4 }, { credits: 8, gradePoints: 0 }])).toBe(2);
  });
  it('no completed subjects → null (not 0)', () => {
    expect(weightedGpa([])).toBeNull();
  });
});

describe('standingFor', () => {
  it.each([[null, 'NONE'], [3.6, 'EXCELLENT'], [3.0, 'GOOD'], [2.1, 'SATISFACTORY'], [1.5, 'AT_RISK']] as const)('%s → %s', (g, s) => expect(standingFor(g)).toBe(s));
});
