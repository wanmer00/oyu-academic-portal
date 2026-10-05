import { Prisma } from '@prisma/client';

/**
 * Severity аудит-событий — детерминированная классификация по названию действия.
 * Ничего не «выдумывается»: уровень выводится из фиксированных правил ниже
 * и одинаково применяется и для фильтра в БД, и для отображения.
 */
export type Severity = 'critical' | 'high' | 'medium' | 'low';
export const SEVERITIES: Severity[] = ['critical', 'high', 'medium', 'low'];

type Rule = { kind: 'exact' | 'contains' | 'startsWith'; value: string };

const CRITICAL: Rule[] = [
  { kind: 'exact', value: 'auth.refresh_reuse_detected' }, // кража refresh-токена
  { kind: 'exact', value: 'user.delete' },
  { kind: 'contains', value: 'role' },
  { kind: 'startsWith', value: 'rbac.' }, // изменение прав ролей
];
const HIGH: Rule[] = [
  { kind: 'contains', value: '.delete' },
  { kind: 'exact', value: 'grade.update' },
  { kind: 'exact', value: 'grade.bulk' },
  { kind: 'exact', value: 'grade.export' },
  { kind: 'exact', value: 'attendance.export' },
  { kind: 'startsWith', value: 'payment.' },
  { kind: 'exact', value: 'request.status_change' },
  { kind: 'exact', value: 'request.reply' },
  { kind: 'startsWith', value: 'room.' },
  { kind: 'startsWith', value: 'schedule.' },
  { kind: 'startsWith', value: 'security.' },
  { kind: 'startsWith', value: 'settings.' },
  { kind: 'exact', value: 'auth.permission_denied' },
  { kind: 'exact', value: 'user.block' },
  { kind: 'exact', value: 'user.unblock' },
  { kind: 'exact', value: 'student.archive' },
];
const MEDIUM: Rule[] = [
  { kind: 'contains', value: '.create' },
  { kind: 'contains', value: '.update' },
  { kind: 'contains', value: '.mark' },
  { kind: 'contains', value: '.grade' },
  { kind: 'contains', value: 'published' },
  { kind: 'contains', value: 'closed' },
  { kind: 'contains', value: 'draft' },
  { kind: 'startsWith', value: 'announcement.' },
  { kind: 'startsWith', value: 'calendar.' },
];

const test = (rules: Rule[], action: string) => {
  const a = action.toLowerCase();
  return rules.some((r) => (r.kind === 'exact' ? a === r.value : r.kind === 'contains' ? a.includes(r.value) : a.startsWith(r.value)));
};

export function severityOf(action: string): Severity {
  if (test(CRITICAL, action)) return 'critical';
  if (test(HIGH, action)) return 'high';
  if (test(MEDIUM, action)) return 'medium';
  return 'low';
}

const cond = (r: Rule): Prisma.AuditLogWhereInput =>
  r.kind === 'exact' ? { action: r.value }
  : r.kind === 'contains' ? { action: { contains: r.value, mode: 'insensitive' } }
  : { action: { startsWith: r.value, mode: 'insensitive' } };

const any = (rules: Rule[]): Prisma.AuditLogWhereInput => ({ OR: rules.map(cond) });

/** Prisma-условие, равносильное severityOf(action) === sev */
export function severityWhere(sev: Severity): Prisma.AuditLogWhereInput {
  switch (sev) {
    case 'critical': return any(CRITICAL);
    case 'high': return { AND: [any(HIGH), { NOT: any(CRITICAL) }] };
    case 'medium': return { AND: [any(MEDIUM), { NOT: any(CRITICAL) }, { NOT: any(HIGH) }] };
    default: return { NOT: { OR: [...CRITICAL, ...HIGH, ...MEDIUM].map(cond) } };
  }
}

/** Убираем секреты из произвольного JSON (diff аудита) перед показом */
const SECRET_KEY = /pass|secret|token|hash|totp|apikey|api_key|authorization|cookie/i;
export function scrub(value: unknown, depth = 0): unknown {
  if (depth > 6 || value == null) return value;
  if (Array.isArray(value)) return value.slice(0, 200).map((v) => scrub(v, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY.test(k) ? '[redacted]' : scrub(v, depth + 1);
    }
    return out;
  }
  return value;
}
