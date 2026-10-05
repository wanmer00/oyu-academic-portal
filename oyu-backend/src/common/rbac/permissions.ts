import { PermissionScope, Role } from '@prisma/client';

/**
 * Каталог прав (permissions) и значения по умолчанию для ролей.
 * Единственный источник правды: из него строятся дефолты в БД (RolePermission), валидация в Roles & Permissions
 * и проверки на backend (PermissionsGuard). Frontend использует ту же карту только для показа/скрытия интерфейса.
 *
 * Scope:
 *   OWN      — только свои данные (студент)
 *   ASSIGNED — назначенные: у преподавателя это пары «предмет × группа» из расписания
 *   ALL      — без ограничений
 */
export type Scope = PermissionScope;
const S = PermissionScope;

export interface PermissionDef {
  key: string;
  group: string;
  /** Допустимые scope для этого права (валидируется при изменении матрицы) */
  scopes: Scope[];
}

const ALL_ONLY = [S.ALL];
const def = (group: string, keys: string[], scopes: Scope[] = ALL_ONLY): PermissionDef[] => keys.map((k) => ({ key: `${group}.${k}`, group, scopes }));

export const PERMISSION_CATALOG: PermissionDef[] = [
  { key: 'admin.access', group: 'admin', scopes: ALL_ONLY },

  ...def('users', ['view', 'create', 'update', 'delete', 'block']),
  ...def('students', ['view'], [S.OWN, S.ASSIGNED, S.ALL]),
  ...def('students', ['create', 'update', 'archive']),
  ...def('teachers', ['view', 'create', 'update', 'assign']),
  ...def('groups', ['view'], [S.ASSIGNED, S.ALL]),
  ...def('groups', ['update']),
  ...def('subjects', ['view'], [S.OWN, S.ASSIGNED, S.ALL]),
  ...def('subjects', ['create', 'update', 'delete']),

  ...def('grades', ['view'], [S.OWN, S.ASSIGNED, S.ALL]),
  ...def('grades', ['create', 'update', 'delete', 'publish'], [S.ASSIGNED, S.ALL]),
  ...def('grades', ['override']),
  ...def('periods', ['manage']),

  ...def('attendance', ['view'], [S.OWN, S.ASSIGNED, S.ALL]),
  ...def('attendance', ['create', 'update', 'delete', 'statistics'], [S.ASSIGNED, S.ALL]),
  ...def('attendance', ['override']),

  ...def('schedule', ['view'], [S.OWN, S.ASSIGNED, S.ALL]),
  ...def('schedule', ['create', 'update', 'delete', 'generate', 'publish', 'settings', 'export', 'override']),
  ...def('schedule', ['availability'], [S.OWN, S.ALL]),

  ...def('reports', ['view', 'export'], [S.ASSIGNED, S.ALL]),

  ...def('roles', ['view', 'update', 'assign']),
  ...def('audit', ['view', 'export', 'review']),
  ...def('settings', ['view', 'update']),

  ...def('requests', ['create'], [S.OWN]),
  { key: 'requests.view', group: 'requests', scopes: [S.OWN, S.ALL] },
  { key: 'requests.review', group: 'requests', scopes: [S.ASSIGNED, S.ALL] },
  ...def('announcements', ['view'], [S.ALL]),
  ...def('announcements', ['manage']),
  ...def('calendar', ['view'], [S.ALL]),
  ...def('calendar', ['manage']),
  { key: 'payments.view', group: 'payments', scopes: [S.OWN, S.ALL] },
  { key: 'payments.pay', group: 'payments', scopes: [S.OWN] },
  { key: 'assignments.view', group: 'assignments', scopes: [S.OWN, S.ASSIGNED, S.ALL] },
  { key: 'assignments.submit', group: 'assignments', scopes: [S.OWN] },
  { key: 'assignments.manage', group: 'assignments', scopes: [S.ASSIGNED, S.ALL] },
  { key: 'materials.view', group: 'materials', scopes: [S.OWN, S.ASSIGNED, S.ALL] },
  { key: 'materials.manage', group: 'materials', scopes: [S.ASSIGNED, S.ALL] },
  ...def('ai', ['use'], [S.OWN, S.ASSIGNED, S.ALL]),

  // Exam Management System
  { key: 'exams.view', group: 'exams', scopes: [S.OWN, S.ASSIGNED, S.ALL] },
  { key: 'exams.pay', group: 'exams', scopes: [S.OWN] },
  { key: 'exams.questions', group: 'exams', scopes: [S.ASSIGNED, S.ALL] },
  { key: 'exams.review', group: 'exams', scopes: [S.ASSIGNED, S.ALL] },
  { key: 'exams.results', group: 'exams', scopes: [S.ASSIGNED, S.ALL] },
  ...def('exams', ['manage', 'payments', 'retakes', 'proctor', 'paper', 'audit']),

  // Апелляции по экзамену (Request.type = APPEAL): просмотр / рассмотрение / решение / изменение баллов
  { key: 'appeals.view', group: 'appeals', scopes: [S.OWN, S.ASSIGNED, S.ALL] },
  { key: 'appeals.review', group: 'appeals', scopes: [S.ASSIGNED, S.ALL] },
  { key: 'appeals.decide', group: 'appeals', scopes: [S.ASSIGNED, S.ALL] },
  { key: 'appeals.adjust_grade', group: 'appeals', scopes: [S.ASSIGNED, S.ALL] },
];

export const PERMISSION_KEYS = PERMISSION_CATALOG.map((p) => p.key);
export const PERMISSION_BY_KEY = new Map(PERMISSION_CATALOG.map((p) => [p.key, p]));
export type PermissionKey = string;

type Matrix = Record<string, Scope>;
const all = (keys: string[], scope: Scope): Matrix => Object.fromEntries(keys.map((k) => [k, scope]));
const keys = (...prefix: string[]) => PERMISSION_KEYS.filter((k) => prefix.some((p) => (p.endsWith('.') ? k.startsWith(p) : k === p)));

/** Значения по умолчанию. После первой синхронизации источник правды — таблица RolePermission. */
export const DEFAULT_MATRIX: Record<Role, Matrix> = {
  SUPER_ADMIN: all(PERMISSION_KEYS, S.ALL),

  ADMIN: {
    // schedule.override (сохранение занятия с конфликтом в черновике) — только SUPER_ADMIN
    ...all(
      [
        'admin.access',
        ...keys('users.view', 'users.create', 'users.update', 'users.block'),
        ...keys('students.', 'teachers.', 'groups.', 'subjects.', 'schedule.', 'reports.', 'attendance.', 'grades.'),
        'periods.manage', 'roles.view', 'roles.assign', 'settings.view',
        'requests.view', 'requests.review', 'announcements.view', 'announcements.manage', 'calendar.view', 'calendar.manage',
        'payments.view', 'ai.use',
        'exams.view', 'exams.review', 'exams.results', 'appeals.view', 'appeals.review', 'appeals.decide', 'appeals.adjust_grade', ...keys('exams.manage', 'exams.payments', 'exams.retakes', 'exams.paper', 'exams.audit'),
      ].filter((k) => k !== 'schedule.override'),
      S.ALL,
    ),
  },

  TEACHER: {
    ...all(['grades.view', 'grades.create', 'grades.update', 'grades.delete', 'grades.publish'], S.ASSIGNED),
    ...all(['attendance.view', 'attendance.create', 'attendance.update', 'attendance.statistics'], S.ASSIGNED),
    ...all(['students.view', 'groups.view', 'subjects.view', 'reports.view', 'reports.export', 'requests.review', 'assignments.view', 'assignments.manage', 'materials.view', 'materials.manage', 'ai.use'], S.ASSIGNED),
    ...all(['schedule.view', 'schedule.availability'], S.OWN),
    ...all(['announcements.view', 'calendar.view'], S.ALL),
    ...all(['exams.view', 'exams.questions', 'exams.results', 'appeals.view', 'appeals.review', 'appeals.decide', 'appeals.adjust_grade'], S.ASSIGNED),
  },

  STUDENT: {
    ...all(['grades.view', 'attendance.view', 'schedule.view', 'students.view', 'subjects.view', 'assignments.view', 'assignments.submit', 'materials.view', 'payments.view', 'payments.pay', 'requests.view', 'requests.create', 'ai.use'], S.OWN),
    ...all(['announcements.view', 'calendar.view'], S.ALL),
    ...all(['exams.view', 'exams.pay', 'appeals.view'], S.OWN),
  },

  // Проктор: только операционный интерфейс экзаменов; админ-панель (admin.access) недоступна
  PROCTOR: {
    ...all(['exams.proctor', 'announcements.view'], S.ALL),
  },
};

/** Маршруты админ-панели доступны только ролям с admin.access */
export const ADMIN_ROLES: Role[] = [Role.SUPER_ADMIN, Role.ADMIN];
