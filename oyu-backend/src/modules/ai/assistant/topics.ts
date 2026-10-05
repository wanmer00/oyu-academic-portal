/**
 * Классификация вопроса → «концепты» → разрешённые для роли «темы».
 *
 * Ассистент никогда не решает сам, какие данные читать: он получает только темы,
 * которые явно разрешены роли пользователя в TOPIC_BY_ROLE. Всё остальное — отказ
 * ДО обращения к данным. Сами данные затем читаются теми же сервисами, что и обычные
 * эндпоинты роли (с их проверками доступа), см. ai-context.service.ts.
 */
/** Persona ассистента. SUPER_ADMIN — темы ADMIN + темы безопасности (бывший OBSERVER). */
export type Role = 'STUDENT' | 'TEACHER' | 'ADMIN' | 'SUPER_ADMIN';
export function personaOf(role: string): Role {
  if (role === 'STUDENT' || role === 'TEACHER' || role === 'ADMIN' || role === 'SUPER_ADMIN') return role;
  throw new Error('No assistant persona for role ' + role);
}

export type Concept =
  | 'secrets' | 'others_data' | 'university' | 'security' | 'logins' | 'anomalies'
  | 'payments' | 'requests' | 'attendance' | 'missing_grades' | 'gpa' | 'grades'
  | 'assignments' | 'schedule' | 'classes' | 'activity';

export type Topic =
  // STUDENT
  | 's_schedule_today' | 's_assignments' | 's_gpa' | 's_grades' | 's_attendance' | 's_requests' | 's_payments'
  // TEACHER
  | 't_classes' | 't_missing_grades' | 't_attendance' | 't_assignments' | 't_activity' | 't_requests'
  // ADMIN
  | 'l_summary' | 'l_attendance' | 'l_requests' | 'l_payments' | 'l_academic' | 'l_person'
  // SUPER_ADMIN (безопасность)
  | 'a_security' | 'a_logins' | 'a_anomalies' | 'a_person';

/** Нормализация: нижний регистр, азербайджанские буквы → латиница без диакритики */
export function normalize(s: string): string {
  return String(s || '')
    .toLowerCase()
    .replace(/ə/g, 'e').replace(/ı/g, 'i').replace(/i̇/g, 'i').replace(/ö/g, 'o').replace(/ü/g, 'u')
    .replace(/ç/g, 'c').replace(/ş/g, 's').replace(/ğ/g, 'g').replace(/ё/g, 'е')
    .replace(/\s+/g, ' ')
    .trim();
}

// Порядок важен только для читаемости; концепты независимы и могут совпасть несколько.
const PATTERNS: Array<[Concept, RegExp]> = [
  // Секреты — отказ для всех ролей, включая аудитора
  ['secrets', /(jwt|secret|секрет|hash|хеш|хэш|api[ -]?key|ключ(и)? api|refresh[ -]?token|рефреш|access[ -]?token|tokens?|токен|cookie|куки|\benv\b|\.env|database url|connection string|парол[ьи] (от|к|пользоват|всех|студент|админ)|password(s)? (of|for)|(show|give|tell|list|dump|покажи|дай|скажи|goster|ver).{0,25}(password|пароль|пароли|паролей|sifre|парол))/],
  // Чужие персональные данные (для студента)
  ['others_data', /(everyone|everybody|whole group|entire group|вся группа|всей групп|всех в групп|hamisinin|other students|all students|every student|classmates?|someone else|another student|одногрупп|однокурсник|других студент|всех студент|чуж(ие|их|ой)|basqa telebe|diger telebe|butun telebe|butun qrup|qrupun (butun|hamisi)|telebelerin hamisi|qrup yoldas|sinif yoldas|his grades|her grades|его оценк|ее оценк|её оценк)/],
  ['university', /(kpi|universit|университет|вуз|faculty-wide|весь факультет|butun fakulte|campus|кампус|institution|по всему|university activity|universitet uzre)/],
  ['security', /(audit|аудит|security|безопасн|tehlukesiz|incident|инцидент|hadise.{0,15}tehluk|security event|событи.{0,20}безопас)/],
  ['logins', /(login|log-in|log in|sign[ -]?in|логин|(^|[^а-я])вход|авторизац|brute|подбор|blocked account|locked|заблокир|bloklan|giris cehd|ugursuz giris|girisler)/],
  ['anomalies', /(anomal|аномал|suspicious|подозрит|subheli|şubheli)/],
  ['payments', /(payment|pay\b|paid|оплат|плат[её]ж|платить|заплат|долг|должен|должн|задолж|debt|owe\b|tuition|invoice|сч[её]т|odenis|borc|haqq)/],
  ['requests', /(request|заявк|muraciet|ariza|erize|appeal|апелляц|справк|certificate|arayis|transfer|перевод в)/],
  ['attendance', /(attend|посещ|пропуск|пропущ|davamiyyet|qayib|absence|absent|buraxilis|dersden qal|miss(ed)?\b|skipped|пропустил|qaib)/],
  ['missing_grades', /((missing|without|no|lack).{0,15}grade|grade.{0,10}missing|(нет|без|отсутств).{0,15}оцен|оцен.{0,15}(нет|отсутств)|qiymetsiz|qiymet(i)? (yox|olmayan|qoyulmayan))/],
  ['gpa', /(gpa|cgpa|средн.{0,6}балл|orta bal|transcript|транскрипт|kredit|credit|академ.{0,10}успева)/],
  ['grades', /(grade|оценк|оценок|qiymet|балл|\bbal\b|marks?\b|score)/],
  ['assignments', /(assign|задани|задач|tapsiriq|homework|домашн|deadline|дедлайн|son tarix|\bdue\b|сдат|сдач|submission|teslim|tehvil|completion|выполнен)/],
  ['schedule', /(schedule|timetable|расписан|cedvel|today|сегодня|bu gun|bugun|tomorrow|завтра|sabah|lesson|занят|(^|[^а-я])пар(ы|а|у)?([^а-я]|$)|ders)/],
  ['classes', /(my classes|my groups|my courses|my students|мои (групп|класс|курс|студент|предмет)|qruplarim|telebelerim|fennlerim|groups?\b|групп|qrup|classes\b)/],
  ['activity', /(activity|активност|aktivli|fealiyyet|progress|прогресс|trend|тренд|dinamika|динамик)/],
];

export function detectConcepts(message: string): Set<Concept> {
  const text = normalize(message);
  const found = new Set<Concept>();
  for (const [c, re] of PATTERNS) if (re.test(text)) found.add(c);
  // «missing grades» — не отдельный запрос оценок
  if (found.has('missing_grades')) found.delete('grades');
  // «аудит» внутри «аудитория»/«auditoriya» — это не безопасность
  if (found.has('security') && /(аудитори|auditoriy|auditorium)/.test(text) && !/(audit log|журнал аудита|audit jurnal|security|безопас)/.test(text)) found.delete('security');
  // пароль в контексте неудачных входов — вопрос аудитора о логинах, а не о секретах
  if (found.has('secrets') && /(fail|неудач|неверн|ugursuz|sehv|bad_password|wrong)/.test(text) && !/(jwt|secret|секрет|hash|хеш|api|token|токен|cookie|env)/.test(text)) found.delete('secrets');
  return found;
}

/** Концепт → тема для роли; отсутствие ключа = у роли нет доступа */
export const TOPIC_BY_ROLE: Record<Role, Partial<Record<Concept, Topic>>> = {
  STUDENT: {
    schedule: 's_schedule_today', classes: 's_schedule_today', assignments: 's_assignments', activity: 's_assignments',
    gpa: 's_gpa', grades: 's_grades', attendance: 's_attendance', requests: 's_requests', payments: 's_payments',
  },
  TEACHER: {
    classes: 't_classes', schedule: 't_classes', missing_grades: 't_missing_grades', grades: 't_activity',
    attendance: 't_attendance', assignments: 't_assignments', activity: 't_activity', requests: 't_requests',
  },
  ADMIN: {
    university: 'l_summary', schedule: 'l_summary', classes: 'l_summary', activity: 'l_academic', grades: 'l_academic', gpa: 'l_academic',
    assignments: 'l_academic', attendance: 'l_attendance', requests: 'l_requests', payments: 'l_payments',
  },
  SUPER_ADMIN: {
    university: 'l_summary', schedule: 'l_summary', classes: 'l_summary', activity: 'l_academic', grades: 'l_academic', gpa: 'l_academic',
    assignments: 'l_academic', attendance: 'l_attendance', requests: 'l_requests', payments: 'l_payments',
    security: 'a_security', logins: 'a_logins', anomalies: 'a_anomalies',
  },
};

/** Концепты, которые запрещены роли всегда (даже если бы маппинг появился по ошибке) */
const ALWAYS_DENIED: Partial<Record<Role, Concept[]>> = {
  STUDENT: ['secrets', 'others_data', 'university', 'security', 'logins', 'anomalies', 'missing_grades'],
  TEACHER: ['secrets', 'university', 'security', 'logins', 'anomalies', 'payments'],
  ADMIN: ['secrets', 'security', 'logins', 'anomalies'],
  SUPER_ADMIN: ['secrets'],
};

export interface Plan {
  topics: Topic[];
  denied: Concept[];
  mentionedLoginIds: string[];
}

/**
 * План ответа: какие темы читать и в чём отказать.
 * `university` у студента/преподавателя — отказ; `others_data` у студента — отказ, и т.д.
 */
export function plan(role: Role, message: string): Plan {
  const concepts = detectConcepts(message);
  const denied: Concept[] = [];
  const topics = new Set<Topic>();
  const always = ALWAYS_DENIED[role] || [];

  // «activity» и «classes» — слабые концепты: дают сводку, только если нет более конкретной темы
  // (иначе «payment activity» превратился бы в платежи + всю академическую активность)
  const WEAK: Concept[] = ['activity', 'classes'];
  for (const c of Array.from(concepts).filter((x) => !WEAK.includes(x))) {
    if (always.includes(c)) { denied.push(c); continue; }
    const t = TOPIC_BY_ROLE[role][c];
    if (t) topics.add(t);
    else if (c !== 'others_data') denied.push(c);
  }
  if (topics.size === 0 && denied.length === 0) {
    for (const c of WEAK) {
      if (!concepts.has(c)) continue;
      if (always.includes(c)) { denied.push(c); continue; }
      const t = TOPIC_BY_ROLE[role][c];
      if (t) { topics.add(t); break; }
      denied.push(c);
    }
  }
  // Запрос про чужие данные отклонён целиком: не подмешиваем «свои» темы, чтобы не создать ложное впечатление ответа
  if (denied.includes('others_data')) topics.clear();
  // «university» у руководства: общая сводка, если нет более конкретной темы
  if ((role === 'ADMIN' || role === 'SUPER_ADMIN') && !concepts.has('university') && topics.size > 1) topics.delete('l_summary');

  const mentionedLoginIds = Array.from(new Set((message.match(/\b\d{10}\b/g) || [])));
  return { topics: Array.from(topics).slice(0, 3), denied: Array.from(new Set(denied)), mentionedLoginIds };
}

/** Быстрые действия по ролям: id темы + готовый запрос (текст задаётся на фронте через i18n) */
export const QUICK_ACTIONS: Record<Role, Topic[]> = {
  STUDENT: ['s_gpa', 's_schedule_today', 's_assignments', 's_attendance', 's_requests'],
  TEACHER: ['t_classes', 't_missing_grades', 't_attendance', 't_assignments'],
  ADMIN: ['l_summary', 'l_requests', 'l_academic', 'l_attendance', 'l_payments'],
  SUPER_ADMIN: ['l_summary', 'a_security', 'a_logins', 'a_anomalies', 'l_requests', 'l_academic'],
};

export const ALL_TOPICS_BY_ROLE: Record<Role, Topic[]> = {
  STUDENT: ['s_schedule_today', 's_assignments', 's_gpa', 's_grades', 's_attendance', 's_requests', 's_payments'],
  TEACHER: ['t_classes', 't_missing_grades', 't_attendance', 't_assignments', 't_activity', 't_requests'],
  ADMIN: ['l_summary', 'l_attendance', 'l_requests', 'l_payments', 'l_academic', 'l_person'],
  SUPER_ADMIN: ['l_summary', 'l_attendance', 'l_requests', 'l_payments', 'l_academic', 'l_person', 'a_security', 'a_logins', 'a_anomalies', 'a_person'],
};
