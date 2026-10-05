import { Concept, Role, Topic } from './topics';

/**
 * Детерминированные ответы из того же компактного контекста, который получила бы модель.
 * Используются, когда модель недоступна (нет ANTHROPIC_API_KEY / stub / ошибка API),
 * чтобы ассистент всегда отвечал реальными данными, а не заглушкой.
 */
export type Lang = 'az' | 'ru' | 'en';

const T = {
  az: {
    denied: '⛔ Bu məlumata sizin rolunuzun ({role}) girişi yoxdur: {what}.',
    deniedPeople: '⛔ Başqa istifadəçilərin şəxsi məlumatlarına giriş yoxdur ({ids}).',
    deniedSecrets: '⛔ Parollar, tokenlər, açarlar və gizli konfiqurasiya heç bir rola göstərilmir.',
    help: 'Mən yalnız sizin rolunuza ({role}) açıq olan məlumatlarla işləyirəm. Məsələn soruşa bilərsiniz:',
    noData: 'Məlumat yoxdur.',
    roles: { STUDENT: 'tələbə', TEACHER: 'müəllim', ADMIN: 'administrator', SUPER_ADMIN: 'baş administrator' },
    concepts: { secrets: 'gizli açarlar/parollar', others_data: 'başqa tələbələrin məlumatları', university: 'bütün universitetin statistikası', security: 'təhlükəsizlik jurnalları', logins: 'giriş jurnalları', anomalies: 'təhlükəsizlik anomaliyaları', payments: 'ödənişlər', requests: 'müraciətlər', attendance: 'davamiyyət', missing_grades: 'qiymətsiz tələbələr (müəllim)', gpa: 'GPA', grades: 'qiymətlər', assignments: 'tapşırıqlar', schedule: 'cədvəl', classes: 'dərslər/qruplar', activity: 'akademik aktivlik' },
  },
  ru: {
    denied: '⛔ У вашей роли ({role}) нет доступа к этим данным: {what}.',
    deniedPeople: '⛔ Нет доступа к персональным данным других пользователей ({ids}).',
    deniedSecrets: '⛔ Пароли, токены, ключи и секретная конфигурация не показываются ни одной роли.',
    help: 'Я работаю только с данными, доступными вашей роли ({role}). Например, можно спросить:',
    noData: 'Нет данных.',
    roles: { STUDENT: 'студент', TEACHER: 'преподаватель', ADMIN: 'администратор', SUPER_ADMIN: 'супер-администратор' },
    concepts: { secrets: 'секреты/пароли', others_data: 'данные других студентов', university: 'статистика всего университета', security: 'журналы безопасности', logins: 'журналы входов', anomalies: 'аномалии безопасности', payments: 'платежи', requests: 'заявки', attendance: 'посещаемость', missing_grades: 'студенты без оценок (для преподавателя)', gpa: 'GPA', grades: 'оценки', assignments: 'задания', schedule: 'расписание', classes: 'классы/группы', activity: 'учебная активность' },
  },
  en: {
    denied: '⛔ Your role ({role}) has no access to: {what}.',
    deniedPeople: '⛔ No access to other users’ personal data ({ids}).',
    deniedSecrets: '⛔ Passwords, tokens, keys and secret configuration are never shown to any role.',
    help: 'I only use data available to your role ({role}). For example, you can ask:',
    noData: 'No data.',
    roles: { STUDENT: 'student', TEACHER: 'teacher', ADMIN: 'administrator', SUPER_ADMIN: 'super administrator' },
    concepts: { secrets: 'secrets/passwords', others_data: 'other students’ data', university: 'university-wide statistics', security: 'security logs', logins: 'login logs', anomalies: 'security anomalies', payments: 'payments', requests: 'requests', attendance: 'attendance', missing_grades: 'students without grades (teacher view)', gpa: 'GPA', grades: 'grades', assignments: 'assignments', schedule: 'schedule', classes: 'classes/groups', activity: 'academic activity' },
  },
} as const;

export const EXAMPLES: Record<Role, Record<Lang, string[]>> = {
  STUDENT: {
    az: ['Bu gün hansı dərslərim var?', 'Hansı tapşırıqların vaxtı çatır?', 'GPA-mı izah et', 'Davamiyyətimi göstər', 'Hansı müraciətlərim gözləyir?'],
    ru: ['Какие у меня сегодня пары?', 'Какие задания скоро сдавать?', 'Объясни мой GPA', 'Покажи мою посещаемость', 'Какие заявки в ожидании?'],
    en: ['What classes do I have today?', 'What assignments are due?', 'Explain my GPA', 'Show my attendance', 'What requests are pending?'],
  },
  TEACHER: {
    az: ['Hansı tələbələrin qiyməti yoxdur?', 'Davamiyyəti xülasə et', 'Hansı tapşırıqların icrası aşağıdır?', 'Qruplarımın akademik aktivliyi'],
    ru: ['У каких студентов нет оценок?', 'Сводка по посещаемости', 'У каких заданий низкое выполнение?', 'Учебная активность моих групп'],
    en: ['Which students have missing grades?', 'Summarize attendance', 'Which assignments have low completion?', 'Show academic activity for my groups'],
  },
  ADMIN: {
    az: ['Universitetin aktivliyini xülasə et', 'Davamiyyət trendləri', 'Müraciətləri xülasə et', 'Ödəniş aktivliyi'],
    ru: ['Сводка активности университета', 'Динамика посещаемости', 'Сводка по заявкам', 'Платёжная активность'],
    en: ['Summarize university activity', 'Show attendance trends', 'Summarize requests', 'Show payment activity'],
  },
  SUPER_ADMIN: {
    az: ['Universitetin aktivliyini xülasə et', 'Son təhlükəsizlik hadisələri', 'Uğursuz girişləri göstər', 'Anomaliyaları xülasə et'],
    ru: ['Сводка активности университета', 'Сводка последних событий безопасности', 'Покажи неудачные входы', 'Сводка аномалий'],
    en: ['Summarize university activity', 'Summarize recent security events', 'Show failed login activity', 'Summarize anomalies'],
  },
};

const H: Record<Lang, Record<string, string>> = {
  az: {
    today: '📅 **Bu günün dərsləri** ({date})', noClassesToday: 'Bu gün dərs yoxdur.', nextDay: 'Növbəti dərs günü: {date}',
    asg: '📝 **Tapşırıqlar**: yaxınlaşan {up}, gecikmiş {od}, təhvil verilmiş {sub}', upcoming: 'Yaxınlaşan:', overdue: 'Gecikmiş:', due: 'son tarix',
    gpa: '🎓 **GPA (4.0)**: {gpa} · kreditlər {earned}/{total}', gpaExplain: 'GPA kreditlərlə çəkili ortadır: hər tamamlanmış fənnin 100-ballıq yekunu bala çevrilir (90+ = 4.0, 80–89 = 3.3–3.7, 70–79 = 2.7–3.0, 60–69 = 2.0–2.3, 51–59 = 1.0, 51-dən aşağı = 0). Keçid balı 51.', bySem: 'Semestrlər:', weakest: 'Cari semestrdə ən aşağı fənlər:',
    grades: '⭐ **Son qiymətlər** ({n})',
    att: '✅ **Davamiyyət**: ümumi {rate}', attRisk: 'Risk: ', attRule: 'Hesablanan buraxılış = qayıb + gecikmə/2.',
    req: '📨 **Müraciətlər**: {counts}', pending: 'Gözləyənlər:', decisions: 'Son qərarlar:',
    pay: '💳 **Ödənişlər** (demo): ödənilib {paid} AZN, gözləyir {pend} AZN, gecikmiş {od}',
    tClasses: '👥 **Dərslərim**', stud: 'tələbə', avg: 'orta', attShort: 'davamiyyət', toGrade: 'yoxlanılmalı',
    tMissing: '🔎 **Qiymətsiz tələbələr**: cəmi {n}; yoxlanılmalı işlər {p}', none: 'yoxdur', jFinal: 'Yekun', jMid: 'Aralıq', jSem: 'Seminar', jTotal: 'Cəmi', jPending: 'gözlənilir', jProv: 'ilkin', jSemInc: 'seminar cavabı <3',
    tAtt: '✅ **Davamiyyət xülasəsi**: ümumi {rate}', lowAtt: 'Aşağı davamiyyət:',
    tAsg: '📝 **Tapşırıqlar**: dərc {pub}, qaralama {dr}, bağlı {cl}', low: 'Aşağı icra (<50%):', soon: 'Yaxın son tarixlər:',
    tAct: '📊 **Akademik aktivlik**: orta bal {avg}, davamiyyət {att}, tapşırıq icrası {comp}; yoxlanılmalı {pg}, son 7 gündə təhvil {s7}', risk: 'Risk altında:',
    tReq: '📨 **Qruplarımın müraciətləri**: {counts}',
    lSum: '🏛 **Universitet xülasəsi**', lStud: 'Tələbələr: {n} ({g} qrup) · Müəllimlər: {t}', lAtt: 'Davamiyyət 30 gün: {r} (ümumi {a})', lAcad: 'Orta bal: {avg} · 7 gündə qiymət: {g7} · təhvil: {s7} · aktiv tapşırıq: {act}', lReq: 'Müraciətlər: {c} · 7 gündən köhnə gözləyən: {old}', lPay: 'Gecikmiş ödənişlər: {n} faktura, {a} AZN', lSch: 'Cədvəl: {s} slot, bu gün {t}, konflikt {c}',
    lAttT: '📈 **Davamiyyət trendi**: 30 gün {r}', week: 'həftə', lReqT: '📨 **Müraciətlər**: {c} · 7 gündən köhnə: {old}', byType: 'Növ üzrə:',
    lPayT: '💳 **Ödənişlər** (demo): toplanıb {paid} AZN, borc {debt} AZN, borclu {d}', debtGroup: 'Qruplar üzrə borc:',
    lAcadT: '📚 **Akademik aktivlik**: orta bal {avg}; semestrlər:', person: '👤 **İstifadəçi**',
    aSec: '🛡 **Təhlükəsizlik**: uğursuz giriş (24s) {f}, bloklanmış {l}, açıq anomaliya {o} (kritik {c}), vacib hadisə (7g) {i}', events: 'Son vacib hadisələr:',
    aLog: '🔐 **Girişlər**: 24 saat — uğurlu {s}, uğursuz {f}; 7 gün — uğurlu {s7}, uğursuz {f7}, unikal IP {ip}', reasons: 'Səbəblər (7g):', recentFail: 'Son uğursuz:',
    aAn: '⚠️ **Anomaliyalar** (7 gün): cəmi {n}, açıq {o}', aPerson: '🔐 **Hesab üzrə girişlər**',
  },
  ru: {
    today: '📅 **Занятия сегодня** ({date})', noClassesToday: 'Сегодня занятий нет.', nextDay: 'Ближайший учебный день: {date}',
    asg: '📝 **Задания**: предстоящих {up}, просроченных {od}, сдано {sub}', upcoming: 'Ближайшие:', overdue: 'Просроченные:', due: 'срок',
    gpa: '🎓 **GPA (4.0)**: {gpa} · кредиты {earned}/{total}', gpaExplain: 'GPA — средневзвешенное по кредитам: итог каждого завершённого предмета (100 баллов) переводится в баллы (90+ = 4.0, 80–89 = 3.3–3.7, 70–79 = 2.7–3.0, 60–69 = 2.0–2.3, 51–59 = 1.0, ниже 51 = 0). Проходной балл 51.', bySem: 'По семестрам:', weakest: 'Самые низкие предметы текущего семестра:',
    grades: '⭐ **Последние оценки** ({n})',
    att: '✅ **Посещаемость**: всего {rate}', attRisk: 'Риск: ', attRule: 'Засчитанные пропуски = отсутствия + опоздания/2.',
    req: '📨 **Заявки**: {counts}', pending: 'В ожидании:', decisions: 'Последние решения:',
    pay: '💳 **Платежи** (демо): оплачено {paid} AZN, к оплате {pend} AZN, просрочено {od}',
    tClasses: '👥 **Мои классы**', stud: 'студ.', avg: 'ср.', attShort: 'посещ.', toGrade: 'на проверку',
    tMissing: '🔎 **Студенты без оценок**: всего {n}; работ на проверке {p}', none: 'нет', jFinal: 'Экзамен', jMid: 'Midterm', jSem: 'Семинар', jTotal: 'Итого', jPending: 'ожидается', jProv: 'предварительно', jSemInc: 'семинарских ответов <3',
    tAtt: '✅ **Посещаемость**: всего {rate}', lowAtt: 'Низкая посещаемость:',
    tAsg: '📝 **Задания**: опубликовано {pub}, черновиков {dr}, закрыто {cl}', low: 'Низкое выполнение (<50%):', soon: 'Ближайшие сроки:',
    tAct: '📊 **Учебная активность**: ср. балл {avg}, посещаемость {att}, выполнение заданий {comp}; на проверке {pg}, сдач за 7 дней {s7}', risk: 'В зоне риска:',
    tReq: '📨 **Заявки моих групп**: {counts}',
    lSum: '🏛 **Сводка по университету**', lStud: 'Студентов: {n} ({g} групп) · Преподавателей: {t}', lAtt: 'Посещаемость за 30 дней: {r} (всего {a})', lAcad: 'Средний балл: {avg} · оценок за 7 дней: {g7} · сдач: {s7} · активных заданий: {act}', lReq: 'Заявки: {c} · ждут дольше 7 дней: {old}', lPay: 'Просроченные платежи: {n} счетов, {a} AZN', lSch: 'Расписание: {s} слотов, сегодня {t}, конфликтов {c}',
    lAttT: '📈 **Динамика посещаемости**: за 30 дней {r}', week: 'неделя', lReqT: '📨 **Заявки**: {c} · ждут дольше 7 дней: {old}', byType: 'По типам:',
    lPayT: '💳 **Платежи** (демо): собрано {paid} AZN, задолженность {debt} AZN, должников {d}', debtGroup: 'Долг по группам:',
    lAcadT: '📚 **Учебная активность**: средний балл {avg}; по семестрам:', person: '👤 **Пользователь**',
    aSec: '🛡 **Безопасность**: неудачных входов (24 ч) {f}, заблокировано {l}, открытых аномалий {o} (критичных {c}), важных событий (7 дн.) {i}', events: 'Последние важные события:',
    aLog: '🔐 **Входы**: 24 ч — успешных {s}, неудачных {f}; 7 дней — успешных {s7}, неудачных {f7}, уникальных IP {ip}', reasons: 'Причины (7 дн.):', recentFail: 'Последние неудачные:',
    aAn: '⚠️ **Аномалии** (7 дней): всего {n}, открытых {o}', aPerson: '🔐 **Входы по аккаунту**',
  },
  en: {
    today: '📅 **Today’s classes** ({date})', noClassesToday: 'No classes today.', nextDay: 'Next class day: {date}',
    asg: '📝 **Assignments**: upcoming {up}, overdue {od}, submitted {sub}', upcoming: 'Upcoming:', overdue: 'Overdue:', due: 'due',
    gpa: '🎓 **GPA (4.0)**: {gpa} · credits {earned}/{total}', gpaExplain: 'GPA is the credit-weighted average: each completed subject’s 100-point result becomes grade points (90+ = 4.0, 80–89 = 3.3–3.7, 70–79 = 2.7–3.0, 60–69 = 2.0–2.3, 51–59 = 1.0, below 51 = 0). Pass mark is 51.', bySem: 'By semester:', weakest: 'Lowest subjects this semester:',
    grades: '⭐ **Recent grades** ({n})',
    att: '✅ **Attendance**: overall {rate}', attRisk: 'At risk: ', attRule: 'Counted absences = absences + lates/2.',
    req: '📨 **Requests**: {counts}', pending: 'Pending:', decisions: 'Recent decisions:',
    pay: '💳 **Payments** (demo): paid {paid} AZN, outstanding {pend} AZN, overdue {od}',
    tClasses: '👥 **My classes**', stud: 'students', avg: 'avg', attShort: 'attendance', toGrade: 'to grade',
    tMissing: '🔎 **Students without grades**: {n} total; submissions to grade {p}', none: 'none', jFinal: 'Final', jMid: 'Midterm', jSem: 'Seminar', jTotal: 'Total', jPending: 'pending', jProv: 'provisional', jSemInc: 'seminar answers <3',
    tAtt: '✅ **Attendance summary**: overall {rate}', lowAtt: 'Low attendance:',
    tAsg: '📝 **Assignments**: published {pub}, drafts {dr}, closed {cl}', low: 'Low completion (<50%):', soon: 'Due soon:',
    tAct: '📊 **Academic activity**: avg grade {avg}, attendance {att}, assignment completion {comp}; to grade {pg}, submissions last 7 days {s7}', risk: 'At risk:',
    tReq: '📨 **Requests from my groups**: {counts}',
    lSum: '🏛 **University summary**', lStud: 'Students: {n} ({g} groups) · Teachers: {t}', lAtt: 'Attendance 30 days: {r} (overall {a})', lAcad: 'Average grade: {avg} · grades in 7 days: {g7} · submissions: {s7} · active assignments: {act}', lReq: 'Requests: {c} · pending over 7 days: {old}', lPay: 'Overdue payments: {n} invoices, {a} AZN', lSch: 'Schedule: {s} slots, {t} today, {c} conflicts',
    lAttT: '📈 **Attendance trend**: 30 days {r}', week: 'week', lReqT: '📨 **Requests**: {c} · pending over 7 days: {old}', byType: 'By type:',
    lPayT: '💳 **Payments** (demo): collected {paid} AZN, outstanding {debt} AZN, debtors {d}', debtGroup: 'Debt by group:',
    lAcadT: '📚 **Academic activity**: average grade {avg}; by term:', person: '👤 **User**',
    aSec: '🛡 **Security**: failed logins (24h) {f}, locked {l}, open anomalies {o} ({c} critical), important events (7d) {i}', events: 'Recent important events:',
    aLog: '🔐 **Logins**: 24h — successful {s}, failed {f}; 7 days — successful {s7}, failed {f7}, unique IPs {ip}', reasons: 'Reasons (7d):', recentFail: 'Recent failures:',
    aAn: '⚠️ **Anomalies** (7 days): {n} total, {o} open', aPerson: '🔐 **Logins for account**',
  },
};

const fill = (s: string, v: Record<string, unknown>) => s.replace(/\{(\w+)\}/g, (_, k) => (v[k] == null ? '—' : String(v[k])));
const pct = (v: unknown) => (v == null ? '—' : v + '%');
const counts = (o: Record<string, number> | undefined) => (o && Object.keys(o).length ? Object.entries(o).map(([k, v]) => `${k} ${v}`).join(', ') : '0');

export function denialText(lang: Lang, role: Role, denied: Concept[], deniedIds: string[]): string[] {
  const t = T[lang];
  const lines: string[] = [];
  if (denied.includes('secrets')) lines.push(t.deniedSecrets);
  const rest = denied.filter((c) => c !== 'secrets');
  if (rest.length) lines.push(fill(t.denied, { role: t.roles[role], what: rest.map((c) => t.concepts[c]).join(', ') }));
  if (deniedIds.length) lines.push(fill(t.deniedPeople, { ids: deniedIds.join(', ') }));
  return lines;
}

export function helpText(lang: Lang, role: Role): string {
  return fill(T[lang].help, { role: T[lang].roles[role] }) + '\n' + EXAMPLES[role][lang].map((e) => '• ' + e).join('\n');
}

export function render(lang: Lang, topic: Topic, d: any): string {
  const h = H[lang];
  const L: string[] = [];
  const noData = T[lang].noData;
  switch (topic) {
    case 's_schedule_today':
      L.push(fill(h.today, { date: d.date }));
      if (d.classes.length) d.classes.forEach((c: any) => L.push(`• ${c.time} — ${c.subject}, ${c.room}${c.teacher ? ' · ' + c.teacher : ''}`));
      else { L.push(h.noClassesToday); if (d.nextClassDay) { L.push(fill(h.nextDay, { date: d.nextClassDay.date })); d.nextClassDay.classes.forEach((c: any) => L.push(`• ${c.time} — ${c.subject}, ${c.room}`)); } }
      break;
    case 's_assignments':
      L.push(fill(h.asg, { up: d.counts.upcoming, od: d.counts.overdue, sub: d.counts.submitted }));
      if (d.overdue.length) { L.push(h.overdue); d.overdue.forEach((a: any) => L.push(`• ${a.subject}: ${a.title} (${h.due} ${a.due})`)); }
      if (d.upcoming.length) { L.push(h.upcoming); d.upcoming.forEach((a: any) => L.push(`• ${a.subject}: ${a.title} (${h.due} ${a.due})`)); }
      break;
    case 's_gpa':
      L.push(fill(h.gpa, { gpa: d.cumulativeGPA, earned: d.earnedCredits, total: d.totalCredits }));
      L.push(h.gpaExplain);
      if (d.bySemester.length) L.push(h.bySem + ' ' + d.bySemester.map((s: any) => `${s.semester}: ${s.gpa}`).join(' · '));
      if (d.currentSubjects.length) L.push(h.weakest + ' ' + d.currentSubjects.slice(0, 3).map((s: any) => `${s.subject} ${s.value} (${s.letter})`).join(', '));
      break;
    case 's_grades':
      L.push(fill(h.grades, { n: d.count }));
      d.subjects.forEach((s: any) => L.push(`• ${s.subject}: ${h.jFinal} ${s.final ?? '—'}/50 · ${h.jMid} ${s.midterm ?? '—'}/30 · ${h.jSem} ${s.seminar != null ? s.seminar + '/20' : h.jPending + ' ' + s.seminarAnswers + '/' + s.seminarRequired} · ${h.jTotal} ${s.total}/100${s.provisional ? ' (' + h.jProv + ')' : ''}`));
      break;
    case 's_attendance': {
      L.push(fill(h.att, { rate: pct(d.overallRate) }));
      d.bySubject.forEach((s: any) => L.push(`• ${s.subject}: ${s.present}/${s.classes}, ${s.countedAbsences}/${s.maxAbsences}${s.status !== 'OK' ? ' ⚠️ ' + s.status : ''}`));
      const risk = d.bySubject.filter((s: any) => s.status !== 'OK');
      if (risk.length) L.push(h.attRisk + risk.map((s: any) => s.subject).join(', '));
      L.push(h.attRule);
      break;
    }
    case 's_requests':
      L.push(fill(h.req, { counts: counts(d.counts) }));
      if (d.pending.length) { L.push(h.pending); d.pending.forEach((r: any) => L.push(`• ${r.type} (${r.created}): ${r.text}`)); }
      if (d.recentDecisions.length) { L.push(h.decisions); d.recentDecisions.forEach((r: any) => L.push(`• ${r.type}: ${r.status}${r.note ? ' — ' + r.note : ''}`)); }
      break;
    case 's_payments':
      L.push(fill(h.pay, { paid: d.summary.totalPaid, pend: d.summary.totalPending, od: d.summary.overdueCount }));
      d.open.forEach((p: any) => L.push(`• ${p.type}: ${p.amount} AZN, ${p.status}, ${p.due}${p.overdue ? ' ⚠️' : ''}`));
      break;
    case 't_classes':
      L.push(h.tClasses);
      d.classes.forEach((c: any) => L.push(`• ${c.subject} · ${c.group}: ${c.students} ${h.stud}, ${h.avg} ${c.avgGrade ?? '—'}, ${h.attShort} ${pct(c.attendanceRate)}${c.pendingGrading ? `, ${h.toGrade} ${c.pendingGrading}` : ''}`));
      (d.students || []).forEach((s: any) => L.push(`👤 ${s.name} (${s.subject} · ${s.group}): ${h.avg} ${s.currentGrade ?? '—'}, ${h.attShort} ${pct(s.attendanceRate)}, ${s.total}/100`));
      break;
    case 't_missing_grades':
      L.push(fill(h.tMissing, { n: d.totalWithoutGrades, p: d.totalPendingGrading }));
      d.classes.forEach((c: any) => L.push(`• ${c.subject} · ${c.group}: ${c.withoutGrades.length ? c.withoutGrades.join(', ') : h.none}${c.seminarIncompleteCount ? ` · ${h.jSemInc}: ${c.seminarIncompleteCount}` : ''}${c.pendingGrading ? ` · ${h.toGrade} ${c.pendingGrading}` : ''}`));
      break;
    case 't_attendance':
      L.push(fill(h.tAtt, { rate: pct(d.overallRate) }));
      d.byClass.forEach((c: any) => L.push(`• ${c.subject} · ${c.group}: ${pct(c.rate)}`));
      if (d.lowAttendanceStudents.length) { L.push(h.lowAtt); d.lowAttendanceStudents.forEach((s: any) => L.push(`• ${s.name} (${s.subject}): ${pct(s.rate)}`)); }
      break;
    case 't_assignments':
      L.push(fill(h.tAsg, { pub: d.counts.published, dr: d.counts.draft, cl: d.counts.closed }));
      if (d.lowCompletion.length) { L.push(h.low); d.lowCompletion.forEach((a: any) => L.push(`• ${a.subject}: ${a.title} — ${a.submitted}/${a.expected} (${a.completion}%)`)); }
      if (d.dueSoon.length) { L.push(h.soon); d.dueSoon.forEach((a: any) => L.push(`• ${a.subject}: ${a.title} (${a.due})`)); }
      break;
    case 't_activity':
      L.push(fill(h.tAct, { avg: d.overview.averageGrade, att: pct(d.overview.attendanceRate), comp: pct(d.overview.assignmentCompletion), pg: d.pendingGrading, s7: d.submissionsLast7d }));
      d.byClass.forEach((c: any) => L.push(`• ${c.subject} · ${c.group}: ${h.avg} ${c.avg ?? '—'}, ${h.attShort} ${pct(c.attendance)}`));
      if (d.atRisk.length) L.push(h.risk + ' ' + d.atRisk.map((r: any) => `${r.name} (${r.subject})`).join(', '));
      (d.students || []).forEach((s: any) => L.push(`👤 ${s.name} (${s.subject}): ${h.avg} ${s.currentGrade ?? '—'}, ${h.attShort} ${pct(s.attendanceRate)}`));
      break;
    case 't_requests':
      L.push(fill(h.tReq, { counts: counts(d.counts) }));
      d.pending.forEach((r: any) => L.push(`• ${r.type}: ${r.student} (${r.group ?? '—'}), ${r.created}`));
      break;
    case 'l_summary':
      L.push(h.lSum);
      L.push(fill(h.lStud, { n: d.students.total, g: d.students.groups, t: d.teachers.total }));
      L.push(fill(h.lAtt, { r: pct(d.attendance.rate30d), a: pct(d.attendance.rateAll) }));
      L.push(fill(h.lAcad, { avg: d.academic.averageGrade, g7: d.academic.grades7d, s7: d.academic.submissions7d, act: d.academic.activeAssignments }));
      L.push(fill(h.lReq, { c: counts(d.requests.byStatus), old: d.requests.pendingOlderThan7d }));
      L.push(fill(h.lPay, { n: d.payments.overdue.count, a: d.payments.overdue.amount }));
      L.push(fill(h.lSch, { s: d.schedule.slots, t: d.schedule.today, c: d.schedule.conflicts }));
      break;
    case 'l_attendance':
      L.push(fill(h.lAttT, { r: pct(d.rate30d) }));
      d.weekly.forEach((w: any) => L.push(`• ${w.week}: ${pct(w.rate)} (${w.records})`));
      break;
    case 'l_requests':
      L.push(fill(h.lReqT, { c: counts(d.byStatus), old: d.pendingOlderThan7d }));
      L.push(h.byType + ' ' + Object.entries(d.byType).map(([k, v]) => `${k}: ${counts(v as Record<string, number>)}`).join('; '));
      break;
    case 'l_payments':
      L.push(fill(h.lPayT, { paid: d.summary.paidAzn, debt: d.summary.debtAzn, d: d.summary.debtorsCount }));
      if (d.debtByGroup.length) L.push(h.debtGroup + ' ' + d.debtByGroup.map((g: any) => `${g.group} ${g.debt} AZN`).join(', '));
      break;
    case 'l_academic':
      L.push(fill(h.lAcadT, { avg: d.current.averageGrade }));
      d.byTerm.forEach((t: any) => L.push(`• ${t.period}: ${t.average} (${t.grades})`));
      break;
    case 'l_person':
      L.push(h.person);
      if (!d.users.length) L.push(noData);
      d.users.forEach((u: any) => L.push(`• ${u.name} (${u.loginId}, ${u.role}, ${u.status}${u.locked ? ', locked' : ''})${u.student ? ` — ${u.student.group}` : ''}${u.stats && u.stats.averageGrade != null ? `, avg ${u.stats.averageGrade}, attendance ${pct(u.stats.attendanceRate)}` : ''}`));
      break;
    case 'a_security':
      L.push(fill(h.aSec, { f: d.kpi.failedLogins24h, l: d.kpi.lockedAccounts, o: d.kpi.openAnomalies, c: d.kpi.criticalOpenAnomalies, i: d.kpi.importantEvents7d }));
      if (d.importantEvents.length) { L.push(h.events); d.importantEvents.forEach((e: any) => L.push(`• [${e.severity}] ${e.action} — ${e.actor}, ${String(e.at).slice(0, 16).replace('T', ' ')}`)); }
      break;
    case 'a_logins':
      L.push(fill(h.aLog, { s: d.last24h.successful, f: d.last24h.failed, s7: d.last7d.successful, f7: d.last7d.failed, ip: d.last7d.uniqueFailedIps }));
      if (Object.keys(d.failedByReason7d).length) L.push(h.reasons + ' ' + counts(d.failedByReason7d));
      if (d.recentFailed.length) { L.push(h.recentFail); d.recentFailed.forEach((l: any) => L.push(`• ${l.loginId} — ${l.reason ?? '—'}, ${l.ip ?? '—'}, ${String(l.at).slice(0, 16).replace('T', ' ')}`)); }
      break;
    case 'a_anomalies':
      L.push(fill(h.aAn, { n: d.counts.total, o: d.counts.byStatus.OPEN ?? 0 }));
      d.open.forEach((a: any) => L.push(`• [${a.severity}] ${a.type} — ${a.subject}, ${String(a.at).slice(0, 16).replace('T', ' ')}`));
      break;
    case 'a_person':
      L.push(h.aPerson);
      d.accounts.forEach((a: any) => { L.push(`• ${a.loginId}: ${a.loginEvents}`); a.recent.forEach((x: any) => L.push(`   – ${x.success ? '✓' : '✗ ' + (x.reason ?? '')} ${x.ip ?? ''} ${String(x.at).slice(0, 16).replace('T', ' ')}`)); });
      break;
  }
  return L.join('\n');
}
