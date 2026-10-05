// ============================================================
// Odlar Yurdu University — presentation dataset (bachelor).
// Полностью вымышленные данные: 50 студентов, 5 групп, 10 преподавателей, предметы, аудитории,
// расписание, оценки, посещаемость, задания, платежи, объявления, журнал входов и аудита.
// Всё связано между собой (Student 1 → Group 1 → предметы → преподаватель → оценки/посещаемость/расписание → аудитория).
// Используется и `prisma db seed`, и сбросом демо-базы (DemoResetService / npm run demo:reset).
// ============================================================
import {
  AnnouncementAudience, AttendanceStatus, CalendarEventType, GradeType, PaymentStatus, PaymentType, PrismaClient,
  RequestStatus, RequestType, Role, Shift, StudyLevel, Term, WeekParity,
} from '@prisma/client';
import * as argon2 from 'argon2';
import { seedExams } from './demo-exams';

export const DEMO_PASSWORD = 'Demo@Portal2026';
export const DEMO_PERIOD = { academicYear: '2026-2027', term: 'FALL' as Term };
/** Границы текущего семестра (должны совпадать с students.service) */
const TERM_START = new Date('2026-09-14T00:00:00Z');
const TERM_END = new Date('2027-01-22T00:00:00Z');

type Log = (msg: string) => void;

// ── детерминированный генератор: повторный сброс даёт те же данные ──
function rng(seed: number) {
  let a = seed || 1;
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const r1 = (n: number) => Math.round(n * 10) / 10;
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
const pad = (n: number, w = 4) => String(n).padStart(w, '0');
const DAY = 86400000;
const utcMidnight = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

// ── Оргструктура бакалавриата Odlar Yurdu University (публичные данные oyu.edu.az: факультеты, кафедры, специальности) ──
// track — шаблон учебного плана (иллюстративный, не официальный план университета); null — план ещё не загружен.
type SpecDef = [code: string, name: string, track: string | null];
const ORG: Array<{ name: string; short: string; departments: Array<{ name: string; specialties: SpecDef[] }> }> = [
  { name: 'Təbiət və Texnologiyalar Fakültəsi', short: 'TT', departments: [
    { name: 'Riyaziyyat və informatika', specialties: [['050616', 'İnformasiya texnologiyaları', 'IT'], ['050615', 'İnformasiya təhlükəsizliyi', 'IT'], ['050620', 'Kompüter mühəndisliyi', 'IT']] },
    { name: 'Biologiya və Ekologiya', specialties: [['050501', 'Biologiya', 'BIO'], ['050504', 'Ekologiya', null]] },
    { name: 'Dizayn', specialties: [['050306', 'Dizayn (interyer, qrafik, geyim)', null]] },
  ] },
  { name: 'İqtisadiyyat və İdarəetmə Fakültəsi', short: 'İİ', departments: [
    { name: 'İqtisadiyyat və iqtisadi münasibətlər', specialties: [['050402', 'Biznesin idarə edilməsi', 'ECO'], ['050404', 'Dövlət və bələdiyyə idarəetməsi', 'ECO'], ['050405', 'İqtisadiyyat', 'ECO'], ['050406', 'Maliyyə', 'ECO'], ['050407', 'Marketinq', 'ECO'], ['050408', 'Menecment', 'ECO'], ['050409', 'Mühasibat', 'ECO']] },
    { name: 'Beynəlxalq münasibətlər və Turizm', specialties: [['050201', 'Beynəlxalq münasibətlər', null], ['050810', 'Turizm işinin təşkili', null]] },
  ] },
  { name: 'Humanitar, təhsil və dillər fakültəsi', short: 'HTD', departments: [
    { name: 'Filologiya və Humanitar Fənlər', specialties: [['050205', 'Filologiya (Azərbaycan dili və ədəbiyyatı)', null], ['050205', 'Filologiya (ingilis dili və ədəbiyyatı)', 'LNG']] },
    { name: 'Xarici dillər', specialties: [['050121', 'Xarici dil müəllimliyi (ingilis dili üzrə)', 'LNG'], ['050215', 'Tərcümə (ingilis dili üzrə)', 'LNG']] },
    { name: 'Psixologiya, Pedaqogika və Sosial Fənlər', specialties: [['050112', 'Məktəbəqədər təhsil', null], ['050211', 'Psixologiya', 'PSY'], ['050807', 'Sosial iş', null], ['050118', 'Təhsildə Sosial-Psixoloji Xidmət', 'PSY']] },
  ] },
];

// Учебные планы (8 семестров × 30 кредитов = 240): 3 профильных предмета по 8 кредитов + 2 общеуниверситетских по 3
const TRACKS: Record<string, { dept: string; color: string; sems: string[][] }> = {
  IT: { dept: 'Riyaziyyat və informatika', color: '#3b82f6', sems: [
    ['Riyazi analiz I', 'Proqramlaşdırmanın əsasları', 'İnformatikanın əsasları'], ['Riyazi analiz II', 'Obyekt yönümlü proqramlaşdırma', 'Diskret riyaziyyat'],
    ['Verilənlər strukturları və alqoritmlər', 'Kompüter arxitekturası', 'Xətti cəbr'], ['Əməliyyat sistemləri', 'Verilənlər bazası', 'Ehtimal nəzəriyyəsi və statistika'],
    ['Kompüter şəbəkələri', 'Proqram mühəndisliyi', 'Veb proqramlaşdırma'], ['İnformasiya təhlükəsizliyinin əsasları', 'Süni intellekt', 'Mobil tətbiqlərin hazırlanması'],
    ['Bulud texnologiyaları', 'Paylanmış sistemlər', 'Kriptoqrafiya'], ['Məlumatların təhlili', 'IT layihələrinin idarə edilməsi', 'Rəqəmsal transformasiya'] ] },
  ECO: { dept: 'İqtisadiyyat və iqtisadi münasibətlər', color: '#f59e0b', sems: [
    ['İqtisadi nəzəriyyə', 'Ali riyaziyyat', 'Biznesin əsasları'], ['Mikroiqtisadiyyat', 'Statistika', 'Mühasibat uçotunun əsasları'],
    ['Makroiqtisadiyyat', 'Menecmentin əsasları', 'Marketinqin əsasları'], ['Maliyyə', 'Ekonometrika', 'Təşkilati davranış'],
    ['Korporativ maliyyə', 'İnsan resurslarının idarə edilməsi', 'Beynəlxalq iqtisadiyyat'], ['Strateji menecment', 'Bank işi', 'Rəqəmsal marketinq'],
    ['İnvestisiya təhlili', 'Sahibkarlıq', 'Biznes analitikası'], ['Risk menecmenti', 'Beynəlxalq biznes', 'İqtisadi siyasət'] ] },
  LNG: { dept: 'Xarici dillər', color: '#10b981', sems: [
    ['Dilçiliyə giriş', 'İngilis dilinin praktik qrammatikası I', 'Fonetika'], ['İngilis dilinin praktik qrammatikası II', 'Leksikologiya', 'Ədəbiyyat nəzəriyyəsi'],
    ['Nəzəri qrammatika', 'İngilis ədəbiyyatı tarixi I', 'Danışıq praktikası'], ['Stilistika', 'İngilis ədəbiyyatı tarixi II', 'Tərcümə nəzəriyyəsi'],
    ['Ədəbi tərcümə', 'Müqayisəli dilçilik', 'Akademik yazı'], ['Ardıcıl tərcümə', 'Amerikan ədəbiyyatı', 'Xarici dilin tədrisi metodikası'],
    ['Sinxron tərcümə', 'Mətn təhlili', 'Diskurs təhlili'], ['Peşəkar tərcümə praktikası', 'Sosiolinqvistika', 'Mədəniyyətlərarası kommunikasiya'] ] },
  PSY: { dept: 'Psixologiya, Pedaqogika və Sosial Fənlər', color: '#a855f7', sems: [
    ['Ümumi psixologiya I', 'Anatomiya və fiziologiya', 'Psixologiya tarixi'], ['Ümumi psixologiya II', 'Yaş psixologiyası', 'Riyazi statistika'],
    ['Sosial psixologiya', 'Pedaqoji psixologiya', 'Psixofiziologiya'], ['Şəxsiyyət psixologiyası', 'Eksperimental psixologiya', 'Psixodiaqnostika'],
    ['Klinik psixologiya', 'Ailə psixologiyası', 'Psixoloji məsləhətin əsasları'], ['Təşkilati psixologiya', 'Psixoterapiyanın əsasları', 'Neyropsixologiya'],
    ['Psixoloji tədqiqat metodları', 'Konflikt psixologiyası', 'Böhran psixologiyası'], ['Psixoloji reabilitasiya', 'Psixologiyada etika', 'Sağlamlıq psixologiyası'] ] },
  BIO: { dept: 'Biologiya və Ekologiya', color: '#14b8a6', sems: [
    ['Ümumi biologiya', 'Ümumi kimya', 'Riyaziyyat'], ['Botanika', 'Zoologiya', 'Üzvi kimya'],
    ['Hüceyrə biologiyası', 'Biokimya', 'Mikrobiologiya'], ['Genetika', 'İnsan və heyvan fiziologiyası', 'Ekologiyanın əsasları'],
    ['Molekulyar biologiya', 'Biotexnologiya', 'İmmunologiya'], ['Təkamül nəzəriyyəsi', 'Virusologiya', 'Biostatistika'],
    ['Bioinformatika', 'Bitki fiziologiyası', 'Ətraf mühitin mühafizəsi'], ['Gen mühəndisliyi', 'Hidrobiologiya', 'Biomüxtəliflik'] ] },
};
const COMMON = { dept: 'Filologiya və Humanitar Fənlər', color: '#64748b', sems: [
  ['Azərbaycan tarixi', 'Xarici dil I'], ['Azərbaycan Respublikasının Konstitusiyası və hüququn əsasları', 'Xarici dil II'],
  ['Azərbaycan dilində işgüzar və akademik kommunikasiya', 'Fəlsəfə'], ['Mülki müdafiə', 'Peşəkar xarici dil'],
  ['Sosiologiya', 'Tədqiqat metodları'], ['Etika', 'Layihə idarəetməsinin əsasları'],
  ['İstehsalat təcrübəsi'], ['Buraxılış işi'] ] };
// Выборные предметы (7 и 8 семестры): две альтернативы на семестр, студент выбирает одну (3 кредита)
const ELECTIVES: Record<string, string[][]> = {
  IT: [['Kompüter görməsi', 'Blokçeyn texnologiyaları'], ['DevOps praktikası', 'Oyun proqramlaşdırması']],
  ECO: [['Logistika və təchizat zənciri', 'Elektron ticarət'], ['Davranış iqtisadiyyatı', 'Layihə maliyyələşdirilməsi']],
  LNG: [['Biznes ingilis dili', 'Media tərcüməsi'], ['Audiovizual tərcümə', 'Leksikoqrafiya']],
  PSY: [['Uşaq psixologiyası', 'Sport psixologiyası'], ['Hüquq psixologiyası', 'Reklam psixologiyası']],
  BIO: [['Ekotoksikologiya', 'Bitki biotexnologiyası'], ['Mikrob ekologiyası', 'Molekulyar diaqnostika']],
};
const TRACK_PREFIX: Record<string, string> = { IT: 'IT', ECO: 'IQT', LNG: 'DIL', PSY: 'PSI', BIO: 'BIO' };

// Академические группы (бакалавриат): название · специальность · курс · смена (1 — утро B1–B3, 2 — после обеда B4–B6)
const GROUP_DEFS: Array<[name: string, specialty: string, course: number, shift: 1 | 2]> = [
  ['KM-21', 'Kompüter mühəndisliyi', 2, 1], ['İT-11', 'İnformasiya texnologiyaları', 1, 2], ['İTH-31', 'İnformasiya təhlükəsizliyi', 3, 1], ['BİO-21', 'Biologiya', 2, 2],
  ['BİZ-11', 'Biznesin idarə edilməsi', 1, 1], ['MAL-21', 'Maliyyə', 2, 2], ['MEN-31', 'Menecment', 3, 1], ['MAR-41', 'Marketinq', 4, 2],
  ['FİL-11', 'Filologiya (ingilis dili və ədəbiyyatı)', 1, 2], ['TRC-21', 'Tərcümə (ingilis dili üzrə)', 2, 1], ['PSİ-31', 'Psixologiya', 3, 2], ['XDM-41', 'Xarici dil müəllimliyi (ingilis dili üzrə)', 4, 1],
];
const STUDENTS_PER_GROUP = 10;
// Преподаватели по направлениям (имена обезличены: Teacher N)
const TEACHER_POOLS: Array<[track: string, count: number]> = [['IT', 4], ['ECO', 4], ['LNG', 3], ['PSY', 2], ['BIO', 2], ['COMMON', 5]];
const TITLES = ['Professor', 'Dosent', 'Baş müəllim', 'Müəllim'];

const ROOMS: Array<[string, string, string, number, string, string[]]> = [
  ['A101', 'Əsas korpus', 'classroom', 30, 'Auditoriya A101', ['projector', 'whiteboard']],
  ['A102', 'Əsas korpus', 'classroom', 30, 'Auditoriya A102', ['projector', 'whiteboard']],
  ['A103', 'Əsas korpus', 'classroom', 40, 'Auditoriya A103', ['projector', 'whiteboard']],
  ['A201', 'Əsas korpus', 'lecture_hall', 60, 'Mühazirə zalı A201', ['projector', 'microphone', 'whiteboard']],
  ['A202', 'Əsas korpus', 'lecture_hall', 40, 'Mühazirə zalı A202', ['projector', 'microphone']],
  ['A203', 'Əsas korpus', 'seminar_room', 20, 'Seminar otağı A203', ['whiteboard']],
  ['A204', 'Əsas korpus', 'seminar_room', 20, 'Seminar otağı A204', ['whiteboard', 'projector']],
  ['B101', 'B korpusu', 'computer_lab', 30, 'Kompüter sinfi B101', ['computers', 'projector']],
  ['B102', 'B korpusu', 'computer_lab', 30, 'Kompüter sinfi B102', ['computers', 'projector']],
  ['B201', 'B korpusu', 'lab', 24, 'Laboratoriya B201', ['lab_equipment', 'whiteboard']],
  ['B202', 'B korpusu', 'classroom', 35, 'Auditoriya B202', ['projector', 'whiteboard']],
  ['B203', 'B korpusu', 'classroom', 35, 'Auditoriya B203', ['projector', 'whiteboard']],
  ['B301', 'B korpusu', 'lecture_hall', 80, 'Mühazirə zalı B301', ['projector', 'microphone', 'whiteboard']],
  ['B302', 'B korpusu', 'seminar_room', 18, 'Seminar otağı B302', ['whiteboard']],
];

const ASSIGNMENT_TITLES = ['Ev tapşırığı 1', 'Praktik layihə', 'Keys təhlili', 'Kiçik tədqiqat işi', 'Laboratoriya hesabatı'];

/** Заполняет пустую базу данными для презентации. Возвращает краткую сводку. */
export async function seedDemo(prisma: PrismaClient, log: Log = console.log) {
  const R = rng(20260101);
  const now = new Date();
  const hash = await argon2.hash(DEMO_PASSWORD, { type: argon2.argon2id }); // один хеш на все тестовые аккаунты
  const email = (login: string) => `${login.replace('.demo', '')}@demo.example`;

  // ═══ 0. Оргструктура: факультеты → кафедры → специальности ═══
  const facultyId = new Map<string, string>(), departmentId = new Map<string, string>();
  const specByName = new Map<string, { id: string; code: string; name: string; track: string | null; department: string; faculty: string }>();
  let fo = 0;
  for (const f of ORG) {
    const fr = await prisma.faculty.create({ data: { name: f.name, shortName: f.short, sortOrder: fo++ } });
    facultyId.set(f.name, fr.id);
    for (const d of f.departments) {
      const dr = await prisma.department.create({ data: { name: d.name, facultyId: fr.id } });
      departmentId.set(d.name, dr.id);
      for (const [code, name, track] of d.specialties) {
        const sr = await prisma.specialty.create({ data: { code, name, departmentId: dr.id, level: StudyLevel.BACHELOR, durationYears: 4, totalCredits: 240 } });
        specByName.set(name, { id: sr.id, code, name, track, department: d.name, faculty: f.name });
      }
    }
  }

  // ═══ 1. Руководство (роль ADMIN + должность и область) и SUPER_ADMIN ═══
  const facIds = ORG.map((f) => facultyId.get(f.name)!);
  const leadership: Array<[string, string, string, Record<string, string>]> = [
    ['rector.demo', 'Rector', 'RECTOR', {}],
    ['prorector.demo', 'Vice-Rector', 'VICE_RECTOR', {}],
    ['dean.demo', 'Dean — Təbiət və Texnologiyalar', 'DEAN', { facultyId: facIds[0] }],
    ['dean2.demo', 'Dean — İqtisadiyyat və İdarəetmə', 'DEAN', { facultyId: facIds[1] }],
    ['dean3.demo', 'Dean — Humanitar, təhsil və dillər', 'DEAN', { facultyId: facIds[2] }],
    ['tutor.demo', 'Tutor', 'TUTOR', {}],
    // заведующие всеми кафедрами: kafedra.demo — первая (Riyaziyyat və informatika), далее kafedra2..8.demo
    ...ORG.flatMap((f) => f.departments.map((d) => d.name)).sort((x, y) => (x === 'Riyaziyyat və informatika' ? -1 : y === 'Riyaziyyat və informatika' ? 1 : 0))
      .map((name, i): [string, string, string, Record<string, string>] => [i === 0 ? 'kafedra.demo' : `kafedra${i + 1}.demo`, `Head of Department — ${name}`, 'HEAD_OF_DEPARTMENT', { departmentId: departmentId.get(name)! }]),
  ];
  const leaders: Array<{ id: string; login: string }> = [];
  for (const [login, fullName, position, org] of leadership) {
    const u = await prisma.user.create({ data: { loginId: login, email: email(login), passwordHash: hash, role: Role.ADMIN, fullName, position, ...org, preferredLang: 'az' } });
    leaders.push({ id: u.id, login });
  }
  const admin = leaders[0];
  const tutor = leaders.find((l) => l.login === 'tutor.demo')!;
  await prisma.user.create({ data: { loginId: 'superadmin.demo', email: 'superadmin@demo.example', passwordHash: hash, role: Role.SUPER_ADMIN, fullName: 'System Administrator', preferredLang: 'az' } });

  // ═══ 2. Преподаватели: Teacher 1..N по направлениям ═══
  const teachers: Array<{ id: string; n: number; name: string; track: string }> = [];
  let tn = 0;
  for (const [track, count] of TEACHER_POOLS) {
    const dept = track === 'COMMON' ? COMMON.dept : TRACKS[track].dept;
    for (let k = 0; k < count; k++) {
      const n = ++tn, login = `teacher${n}.demo`;
      const u = await prisma.user.create({
        data: {
          loginId: login, email: email(login), passwordHash: hash, role: Role.TEACHER, fullName: `Teacher ${n}`, preferredLang: 'az', departmentId: departmentId.get(dept),
          teacher: { create: { department: dept, title: TITLES[(n - 1) % TITLES.length], experience: 3 + ((n * 7) % 20) } },
        },
      });
      teachers.push({ id: u.id, n, name: `Teacher ${n}`, track });
    }
  }
  const poolOf = (track: string) => teachers.filter((t) => t.track === track);

  // ═══ 3. Предметы и учебные планы ═══
  const subj = new Map<string, { id: string; code: string; name: string; semester: number; teacherId: string; idx: number }>();
  const trackSubjects = new Map<string, string[][]>(); // track → [semester-1] → codes
  const electiveSubjects = new Map<string, string[][]>(); // track → [0: sem7, 1: sem8] → альтернативы
  let si = 0;
  const addSubject = async (code: string, name: string, credits: number, semester: number, color: string, dept: string, teacherId: string) => {
    const s = await prisma.subject.create({ data: { code, name, credits, semester, color, departmentId: departmentId.get(dept) } });
    subj.set(code, { id: s.id, code, name, semester, teacherId, idx: si++ });
    return code;
  };
  const commonCodes: string[][] = [];
  {
    const pool = poolOf('COMMON'); let k = 0;
    for (let s = 0; s < 8; s++) { commonCodes.push([]); for (let i = 0; i < COMMON.sems[s].length; i++) commonCodes[s].push(await addSubject(`UMM${s + 1}0${i + 1}`, COMMON.sems[s][i], 3, s + 1, COMMON.color, COMMON.dept, pool[k++ % pool.length].id)); }
  }
  for (const [track, t] of Object.entries(TRACKS)) {
    const pool = poolOf(track); let k = 0; const sems: string[][] = [];
    for (let s = 0; s < 8; s++) { sems.push([]); for (let i = 0; i < t.sems[s].length; i++) sems[s].push(await addSubject(`${TRACK_PREFIX[track]}${s + 1}0${i + 1}`, t.sems[s][i], 8, s + 1, t.color, t.dept, pool[k++ % pool.length].id)); }
    trackSubjects.set(track, sems);
    const el: string[][] = [];
    for (let e = 0; e < 2; e++) { el.push([]); for (let i = 0; i < 2; i++) el[e].push(await addSubject(`${TRACK_PREFIX[track]}${7 + e}E${i + 1}`, ELECTIVES[track][e][i], 3, 7 + e, t.color, t.dept, pool[k++ % pool.length].id)); }
    electiveSubjects.set(track, el);
  }
  const semesterCodes = (track: string, sem: number) => [...trackSubjects.get(track)![sem - 1], ...commonCodes[sem - 1], ...(sem >= 7 ? [electiveSubjects.get(track)![sem - 7][0]] : [])];
  let curriculumItems = 0;
  for (const sp of specByName.values()) {
    if (!sp.track) continue;
    const rows = [];
    for (let s = 1; s <= 8; s++) {
      for (const code of [...trackSubjects.get(sp.track)![s - 1], ...commonCodes[s - 1]]) {
        const sj = subj.get(code)!; const common = code.startsWith('UMM');
        rows.push({ specialtyId: sp.id, subjectId: sj.id, semester: s, credits: common ? 3 : 8, kind: 'MANDATORY', control: common && s % 2 === 1 ? 'CREDIT' : 'EXAM', electiveGroup: null as string | null });
      }
      if (s >= 7) for (const code of electiveSubjects.get(sp.track)![s - 7]) rows.push({ specialtyId: sp.id, subjectId: subj.get(code)!.id, semester: s, credits: 3, kind: 'ELECTIVE', control: 'CREDIT', electiveGroup: `E${s}` });
    }
    await prisma.curriculumItem.createMany({ data: rows });
    curriculumItems += rows.length;
  }

  // ═══ 4. Группы и студенты: Student 1..N ═══
  const GROUPS = GROUP_DEFS.map(([name, specialty, course, shift]) => {
    const sp = specByName.get(specialty)!;
    return { name, sp, faculty: sp.faculty, specialty: sp.name, course, semester: course * 2 - 1, level: StudyLevel.BACHELOR as StudyLevel, shift: shift === 1 ? Shift.SHIFT_1 : Shift.SHIFT_2, slots: shift === 1 ? ['B1', 'B2', 'B3'] : ['B4', 'B5', 'B6'] };
  });
  for (const g of GROUPS) await prisma.academicGroup.create({ data: { name: g.name, specialtyId: g.sp.id, course: g.course, level: g.level, tutorId: ['KM-21', 'İT-11'].includes(g.name) ? tutor.id : null } });
  const GROUP_SUBJECTS: Record<string, string[]> = Object.fromEntries(GROUPS.map((g) => [g.name, semesterCodes(g.sp.track!, g.semester)]));
  const students: Array<{ id: string; n: number; group: string; ability: number }> = [];
  let sn = 0;
  for (const g of GROUPS) for (let k = 0; k < STUDENTS_PER_GROUP; k++) {
    const n = ++sn, login = `student${n}.demo`;
    const u = await prisma.user.create({
      data: {
        loginId: login, email: email(login), passwordHash: hash, role: Role.STUDENT, fullName: `Student ${n}`, preferredLang: 'az',
        student: { create: { faculty: g.faculty, specialty: g.specialty, groupName: g.name, course: g.course, semester: g.semester, level: g.level } },
      },
    });
    students.push({ id: u.id, n, group: g.name, ability: n === 1 ? 0.88 : 0.62 + R() * 0.35 });
  }
  log(`  ✓ org: ${ORG.length} faculties, ${departmentId.size} departments, ${specByName.size} specialties, ${GROUPS.length} groups, ${curriculumItems} curriculum items`);
  log(`  ✓ users: ${leaders.length + 1} staff, ${teachers.length} teachers, ${students.length} students`);

  // ═══ 4b. Выборные, практика, выпускные работы ═══
  let projects = 0;
  for (const g of GROUPS) {
    const mine = students.filter((s) => s.group === g.name);
    if (g.semester >= 7) {
      const items = await prisma.curriculumItem.findMany({ where: { specialtyId: g.sp.id, electiveGroup: 'E7' }, include: { subject: { select: { code: true } } } });
      const chosen = items.find((i) => i.subject.code === electiveSubjects.get(g.sp.track!)![0][0]);
      if (chosen) await prisma.electiveChoice.createMany({ data: mine.map((s) => ({ studentId: s.id, curriculumItemId: chosen.id })) });
    }
    const sup = poolOf(g.sp.track!);
    for (const [i, s] of mine.entries()) {
      if (g.course >= 3) { // производственная практика летом после 2 курса — завершена
        await prisma.studentProject.create({ data: { studentId: s.id, type: 'PRACTICE', title: `İstehsalat təcrübəsi — ${g.specialty}`, organization: `Tərəfdaş təşkilat ${(i % 6) + 1}`, supervisorId: sup[i % sup.length].id, startDate: new Date('2026-06-15'), endDate: new Date('2026-07-31'), status: 'COMPLETED', grade: Math.round(70 + s.ability * 28) } });
        projects++;
      }
      if (g.course === 4) { // выпускная работа в процессе
        await prisma.studentProject.create({ data: { studentId: s.id, type: 'THESIS', title: `Buraxılış işi ${i + 1}: ${g.specialty} üzrə tədqiqat`, supervisorId: sup[(i + 1) % sup.length].id, startDate: new Date('2026-10-01'), endDate: new Date('2027-06-15'), status: i % 4 === 0 ? 'PLANNED' : 'IN_PROGRESS' } });
        projects++;
      }
    }
  }
  log(`  ✓ electives & projects: ${projects} practice/thesis records`);

  // ═══ 5. Аудитории ═══
  const rooms: Array<{ id: string; code: string; type: string; capacity: number; building: string }> = [];
  for (const [code, building, type, capacity, name, features] of ROOMS) {
    const r = await prisma.room.create({ data: { code, name, building, floor: Number(code[1]), capacity, type, features } });
    rooms.push({ id: r.id, code, type, capacity, building });
  }

  // ═══ 6. Расписание (текущий период): 1 лекция + 1 семинар в неделю на предмет, без конфликтов ═══
  const slotRows = await prisma.timeSlot.findMany({ where: { isActive: true } });
  const slotByCode = new Map(slotRows.map((s) => [s.code, s]));
  const lectureRoomTypes = (await prisma.lessonType.findUnique({ where: { code: 'lecture' } }))?.roomTypes ?? ['lecture_hall', 'classroom'];
  const seminarRoomTypes = (await prisma.lessonType.findUnique({ where: { code: 'seminar' } }))?.roomTypes ?? ['classroom', 'seminar_room'];
  const teacherBusy = new Set<string>(), groupBusy = new Set<string>(), roomBusy = new Set<string>();
  const groupDayCount = new Map<string, number>();
  const placed: Array<{ group: string; code: string; type: 'lecture' | 'seminar'; day: number; slot: string; roomId: string; roomCode: string; teacherId: string }> = [];
  const days = [1, 2, 3, 4, 5];
  let rot = 0;
  for (const g of GROUPS) {
    for (const code of GROUP_SUBJECTS[g.name]) {
      const sj = subj.get(code)!;
      const teacherId = sj.teacherId;
      for (const type of ['lecture', 'seminar'] as const) {
        const allowed = type === 'lecture' ? lectureRoomTypes : seminarRoomTypes;
        let ok = false;
        // дни с меньшей загрузкой группы — первыми, чтобы неделя выглядела ровно
        const order = [...days].sort((a, b) => (groupDayCount.get(`${g.name}|${a}`) ?? 0) - (groupDayCount.get(`${g.name}|${b}`) ?? 0) || ((a + rot) % 5) - ((b + rot) % 5));
        for (const day of order) {
          for (const sc of g.slots) {
            const slot = slotByCode.get(sc)!;
            const gk = `${g.name}|${day}|${sc}`, tk = `${teacherId}|${day}|${sc}`;
            if (groupBusy.has(gk) || teacherBusy.has(tk)) continue;
            const room = rooms.filter((r) => allowed.includes(r.type) && r.capacity >= 10 && !roomBusy.has(`${r.id}|${day}|${sc}`)).sort((a, b) => a.capacity - b.capacity)[0];
            if (!room) continue;
            groupBusy.add(gk); teacherBusy.add(tk); roomBusy.add(`${room.id}|${day}|${sc}`);
            groupDayCount.set(`${g.name}|${day}`, (groupDayCount.get(`${g.name}|${day}`) ?? 0) + 1);
            placed.push({ group: g.name, code, type, day, slot: slot.code, roomId: room.id, roomCode: room.code, teacherId });
            ok = true; break;
          }
          if (ok) break;
        }
        if (!ok) throw new Error(`demo schedule: cannot place ${g.name} ${code} ${type}`);
        rot++;
      }
    }
  }
  for (const p of placed) {
    const g = GROUPS.find((x) => x.name === p.group)!;
    const slot = slotByCode.get(p.slot)!;
    await prisma.scheduleSlot.create({
      data: {
        subjectId: subj.get(p.code)!.id, teacherId: p.teacherId, roomId: p.roomId, room: p.roomCode, groupName: p.group, dayOfWeek: p.day,
        startTime: slot.startTime, endTime: slot.endTime, type: p.type, shift: g.shift, level: g.level, weekParity: WeekParity.BOTH,
        academicYear: DEMO_PERIOD.academicYear, term: DEMO_PERIOD.term,
      },
    });
  }
  log(`  ✓ rooms: ${rooms.length}, schedule slots: ${placed.length}`);

  // ═══ 7. Академические периоды ═══
  const periods: Array<[string, Term, boolean]> = [['2024-2025', 'FALL', false], ['2024-2025', 'SPRING', false], ['2025-2026', 'FALL', false], ['2025-2026', 'SPRING', false], [DEMO_PERIOD.academicYear, DEMO_PERIOD.term, true]];
  for (const [academicYear, term, open] of periods) await prisma.academicPeriod.create({ data: { academicYear, term, status: open ? 'OPEN' : 'CLOSED', closedAt: open ? null : now, closedBy: open ? null : admin.id } });

  // ═══ 8. Оценки Academic Journal (Final 50 / Midterm 30 / Seminar 20) ═══
  const mkGrade = (studentId: string, subjectId: string, teacherId: string | null, type: GradeType, value: number, max: number, p: { academicYear: string; term: Term; semester: number }, published: boolean) =>
    ({ studentId, subjectId, teacherId, type, value, maxValue: max, academicYear: p.academicYear, term: p.term, semester: p.semester, publishedAt: published ? now : null });
  const gradeRows: ReturnType<typeof mkGrade>[] = [];
  for (const st of students) {
    const g = GROUPS.find((x) => x.name === st.group)!;
    // текущий период: midterm у всех, семинарские ответы; финал — результат экзамена (Exam System)
    for (const code of GROUP_SUBJECTS[st.group]) {
      const sj = subj.get(code)!, tId = sj.teacherId;
      const p = { ...DEMO_PERIOD, semester: g.semester };
      const a = clamp(st.ability + (R() - 0.5) * 0.25, 0.3, 1);
      const published = R() > 0.08;
      gradeRows.push(mkGrade(st.id, sj.id, tId, 'MIDTERM', r1(30 * a), 30, p, published));
      const nSem = 3 + Math.floor(R() * 3);
      for (let i = 0; i < nSem; i++) gradeRows.push(mkGrade(st.id, sj.id, tId, 'SEMINAR', r1(clamp(10 * (a + (R() - 0.5) * 0.3), 3, 10)), 10, p, published));
      // FINAL текущего семестра появляется только из Exam System (после экзамена) — вручную не вводится
    }
    // история: прошлые семестры — только для курсов старше первого
    for (let sem = 1; sem < g.semester; sem++) {
      if (g.level === StudyLevel.MASTER) continue;
      const term: Term = sem % 2 === 1 ? 'FALL' : 'SPRING';
      const codes = semesterCodes(g.sp.track!, sem);
      // k семестров назад от текущей осени 2026-2027: учебный год начался за ceil(k/2) лет до 2026
      const startYear = 2026 - Math.ceil((g.semester - sem) / 2);
      const ay = `${startYear}-${startYear + 1}`;
      for (const code of codes) {
        const sj = subj.get(code)!, tId = sj.teacherId;
        const p = { academicYear: ay, term, semester: sem };
        const a = clamp(st.ability + (R() - 0.5) * 0.3, 0.3, 1);
        gradeRows.push(mkGrade(st.id, sj.id, tId, 'MIDTERM', r1(30 * a), 30, p, true));
        for (let i = 0; i < 3; i++) gradeRows.push(mkGrade(st.id, sj.id, tId, 'SEMINAR', r1(clamp(10 * (a + (R() - 0.5) * 0.3), 3, 10)), 10, p, true));
        gradeRows.push(mkGrade(st.id, sj.id, tId, 'FINAL', r1(clamp(50 * (a + (R() - 0.5) * 0.2), 10, 50)), 50, p, true));
      }
    }
  }
  for (let i = 0; i < gradeRows.length; i += 500) await prisma.grade.createMany({ data: gradeRows.slice(i, i + 500) });
  log(`  ✓ journal grades: ${gradeRows.length}`);

  // ═══ 9. Посещаемость: последние 6 недель по реальным дням расписания ═══
  const attRows: Array<{ studentId: string; subjectId: string; classDate: Date; status: AttendanceStatus; markedBy: string; academicYear: string; term: Term; semester: number }> = [];
  const today = utcMidnight(now);
  // последние 6 недель внутри семестра; если сброс выполнен вне семестра — первые 6 недель семестра
  const lastDay = new Date(Math.min(today.getTime() - DAY, TERM_END.getTime()));
  const inTerm = lastDay >= TERM_START;
  const attTo = inTerm ? lastDay : new Date(TERM_START.getTime() + 41 * DAY);
  const attFrom = inTerm ? new Date(Math.max(TERM_START.getTime(), attTo.getTime() - 41 * DAY)) : TERM_START;
  for (const p of placed) {
    const g = GROUPS.find((x) => x.name === p.group)!;
    const sj = subj.get(p.code)!;
    const groupStudents = students.filter((s) => s.group === p.group);
    for (let d = 0; d <= 41; d++) {
      const date = new Date(attFrom.getTime() + d * DAY);
      if (date > attTo || (date.getUTCDay() || 7) !== p.day) continue;
      for (const st of groupStudents) {
        const x = R();
        const status: AttendanceStatus = x < st.ability * 0.12 ? 'ABSENT' : x < 0.12 ? 'LATE' : x < 0.15 ? 'EXCUSED' : x < 0.3 - st.ability * 0.2 ? 'ABSENT' : 'PRESENT';
        attRows.push({ studentId: st.id, subjectId: sj.id, classDate: date, status, markedBy: p.teacherId, ...DEMO_PERIOD, semester: g.semester });
      }
    }
  }
  // одна и та же пара (предмет, дата) могла попасть дважды (лекция и семинар в один день) — уникальность по (студент, предмет, дата)
  const seen = new Set<string>(); const attUnique = attRows.filter((r) => { const k = `${r.studentId}|${r.subjectId}|${r.classDate.toISOString()}`; if (seen.has(k)) return false; seen.add(k); return true; });
  for (let i = 0; i < attUnique.length; i += 1000) await prisma.attendance.createMany({ data: attUnique.slice(i, i + 1000) });
  log(`  ✓ attendance records: ${attUnique.length}`);

  // ═══ 10. Задания, сдачи, материалы ═══
  let assignments = 0, submissions = 0, materials = 0;
  for (const code of Array.from(new Set(Object.values(GROUP_SUBJECTS).flat()))) {
    const sj = subj.get(code)!, tId = sj.teacherId;
    const subjectName = sj.name;
    for (let k = 0; k < 2; k++) {
      const due = new Date(now.getTime() + (k === 0 ? -10 : 12) * DAY);
      const a = await prisma.assignment.create({
        data: { subjectId: sj.id, teacherId: tId, title: `${subjectName}: ${ASSIGNMENT_TITLES[(sj.idx + k) % ASSIGNMENT_TITLES.length]}`, description: `${subjectName} fənni üzrə tapşırığı yerinə yetirin və nəticəni son tarixdən əvvəl təqdim edin.`, dueDate: due, maxGrade: 100, status: 'PUBLISHED', publishedAt: new Date(now.getTime() - 20 * DAY) },
      });
      assignments++;
      const groups = Object.entries(GROUP_SUBJECTS).filter(([, c]) => c.includes(code)).map(([g]) => g);
      for (const st of students.filter((s) => groups.includes(s.group))) {
        if (k === 1 && R() > 0.2) continue; // будущее задание — сдали единицы
        if (R() > 0.85) continue;
        const graded = k === 0 && R() < 0.75;
        await prisma.submission.create({
          data: {
            assignmentId: a.id, studentId: st.id, submittedAt: new Date(due.getTime() - Math.floor(R() * 5 + 1) * DAY), status: graded ? 'GRADED' : 'SUBMITTED', fileName: `${code.toLowerCase()}_student${st.n}.pdf`,
            ...(graded ? { grade: Math.round(clamp(100 * (st.ability + (R() - 0.5) * 0.25), 35, 100)), feedback: 'Good work. See comments in the report.', gradedAt: new Date(due.getTime() + DAY), gradedBy: tId } : {}),
          },
        });
        submissions++;
      }
    }
    await prisma.material.create({ data: { subjectId: sj.id, teacherId: tId, title: `${subjectName} — syllabus`, type: 'LINK', url: `https://example.com/materials/${code.toLowerCase()}/syllabus` } });
    await prisma.material.create({ data: { subjectId: sj.id, teacherId: tId, title: `${subjectName} — lecture notes`, type: 'LINK', url: `https://example.com/materials/${code.toLowerCase()}/notes` } });
    materials += 2;
  }
  log(`  ✓ assignments: ${assignments}, submissions: ${submissions}, materials: ${materials}`);

  // ═══ 11. Календарь, объявления, обращения, платежи, уведомления ═══
  const y = now.getUTCFullYear();
  const ev = (days: number, len: number, type: CalendarEventType, title: string, description: string, extra: Record<string, unknown> = {}) => ({
    eventDate: new Date(today.getTime() + days * DAY), endDate: len > 0 ? new Date(today.getTime() + (days + len) * DAY) : null, type, title, description, createdBy: admin.id, ...extra,
  });
  await prisma.calendarEvent.createMany({
    data: [
      ev(-20, 0, 'ACADEMIC', 'Semester start', 'The new semester has started.'),
      ev(9, 0, 'HOLIDAY', 'Public holiday', 'Classes are not held.'),
      ev(14, 4, 'EXAM', 'Midterm week', 'Midterm exams for all groups. See the schedule for rooms.'),
      ev(2, 0, 'LECTURE_CANCELLED', 'Lecture cancelled', 'The lecture is cancelled; a make-up class will be announced.', { groupName: 'KM-21' }),
      ev(40, 0, 'EXAM', 'Verilənlər strukturları və alqoritmlər — final imtahanı', 'Written exam, 2 hours', { groupName: 'KM-21', roomCode: 'A201', startTime: '09:00', endTime: '11:00' }),
      ev(42, 0, 'EXAM', 'Kompüter şəbəkələri — final imtahanı', 'Practical exam in the computer lab', { groupName: 'İTH-31', roomCode: 'B101', startTime: '10:00', endTime: '12:00' }),
      ev(60, 14, 'OTHER', 'Winter break', 'University closed for the winter break.'),
      ev(-120 + (y % 2), 0, 'OTHER', 'Open day', 'Open day for prospective students.'),
    ],
  });
  await prisma.announcement.createMany({
    data: [
      { title: 'Welcome to the new semester', body: 'Welcome back! Check your schedule and make sure your profile information is up to date.', audience: AnnouncementAudience.ALL, priority: 'HIGH', pinned: true, createdBy: admin.id },
      { title: 'Midterm exam session', body: 'The midterm session starts in two weeks. Exact dates and rooms are in the calendar.', audience: AnnouncementAudience.STUDENTS, priority: 'URGENT', pinned: true, createdBy: admin.id },
      { title: 'Faculty meeting', body: 'A faculty meeting for all teaching staff will take place on Thursday at 14:00.', audience: AnnouncementAudience.TEACHERS, priority: 'NORMAL', createdBy: admin.id },
      { title: 'KM-21: make-up class', body: 'The cancelled lecture will be made up next week. Details will follow.', audience: AnnouncementAudience.GROUP, groupName: 'KM-21', priority: 'HIGH', createdBy: admin.id },
      { title: 'New library resources', body: 'New e-books and journals are now available in the digital library.', audience: AnnouncementAudience.ALL, priority: 'LOW', createdBy: admin.id },
    ],
  });
  const reqTypes: RequestType[] = ['CERTIFICATE', 'APPEAL', 'TRANSFER', 'OTHER'];
  const reqStatuses: RequestStatus[] = ['PENDING', 'APPROVED', 'REJECTED', 'PENDING'];
  for (let i = 0; i < 10; i++) {
    const st = students[(i * 5 + 1) % students.length];
    const status = reqStatuses[i % 4];
    await prisma.request.create({ data: { userId: st.id, type: reqTypes[i % 4], status, description: ['Certificate of enrolment for a visa application', 'Appeal the midterm grade in a seminar', 'Request to transfer to another group', 'Question about the dormitory application'][i % 4], adminNote: status === 'PENDING' ? null : status === 'APPROVED' ? 'Approved.' : 'Rejected: insufficient grounds.' } });
  }
  const payRows: Array<{ studentId: string; amount: number; type: PaymentType; status: PaymentStatus; description: string; invoiceNumber: string; dueDate: Date; paidAt: Date | null }> = [];
  let inv = 1;
  for (const st of students) {
    const g = GROUPS.find((x) => x.name === st.group)!;
    const tuition = g.level === StudyLevel.MASTER ? 3000 : 2400;
    const x = R();
    const status: PaymentStatus = x < 0.6 ? 'PAID' : x < 0.85 ? 'PENDING' : x < 0.93 ? 'PROCESSING' : 'FAILED';
    payRows.push({ studentId: st.id, amount: tuition, type: 'TUITION', status, description: `${DEMO_PERIOD.academicYear} ${DEMO_PERIOD.term === 'FALL' ? 'Autumn' : 'Spring'} semester — tuition`, invoiceNumber: `INV-${y}-F-${pad(inv++)}`, dueDate: new Date(today.getTime() + (status === 'PENDING' ? (st.n % 2 ? -5 : 20) : -30) * DAY), paidAt: status === 'PAID' ? new Date(today.getTime() - 35 * DAY) : null });
    if (st.n % 4 === 0) payRows.push({ studentId: st.id, amount: 60, type: 'LIBRARY', status: 'PAID', description: 'Library membership', invoiceNumber: `INV-${y}-LIB-${pad(inv++)}`, dueDate: new Date(today.getTime() - 25 * DAY), paidAt: new Date(today.getTime() - 27 * DAY) });
    if (st.n % 9 === 0) payRows.push({ studentId: st.id, amount: 150, type: 'RETAKE', status: 'PENDING', description: 'Exam retake fee', invoiceNumber: `INV-${y}-RT-${pad(inv++)}`, dueDate: new Date(today.getTime() + 10 * DAY), paidAt: null });
  }
  await prisma.payment.createMany({ data: payRows });
  await prisma.notification.createMany({
    data: [
      ...students.map((s) => ({ userId: s.id, type: 'ACADEMIC' as const, title: 'Midterm results published', message: 'Your midterm results are available in the Academic Journal.', link: '/portal.html', readAt: s.n % 3 === 0 ? now : null })),
      ...teachers.map((t) => ({ userId: t.id, type: 'ADMINISTRATIVE' as const, title: 'Faculty meeting on Thursday', message: 'A faculty meeting is scheduled for Thursday at 14:00.', link: null, readAt: null })),
    ],
  });
  log(`  ✓ calendar, announcements, requests, payments (${payRows.length}), notifications`);

  // ═══ 12. Демо-активность: журнал входов и аудита ═══
  const actors = [...teachers.map((t) => ({ id: t.id, login: `teacher${t.n}.demo` })), ...students.slice(0, 20).map((s) => ({ id: s.id, login: `student${s.n}.demo` })), { id: admin.id, login: 'rector.demo' }];
  const loginRows: Array<{ userId: string | null; loginId: string; success: boolean; reason: string | null; ip: string; userAgent: string; createdAt: Date }> = [];
  const ua = ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) Safari/605.1', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4) Mobile Safari/604.1', 'Mozilla/5.0 (X11; Linux x86_64) Firefox/125.0'];
  for (const a of actors) {
    for (let i = 0; i < 3; i++) loginRows.push({ userId: a.id, loginId: a.login, success: true, reason: null, ip: `203.0.113.${10 + (a.login.length * 7 + i * 13) % 200}`, userAgent: ua[(a.login.length + i) % ua.length], createdAt: new Date(now.getTime() - Math.floor(R() * 14 * DAY)) });
  }
  const failed = [['student7.demo', 'bad_password'], ['student7.demo', 'bad_password'], ['student7.demo', 'bad_password'], ['admin', 'not_found'], ['root', 'not_found'], ['teacher3.demo', 'bad_password']];
  failed.forEach(([id, reason], i) => loginRows.push({ userId: id.endsWith('.demo') ? actors.find((a) => a.login === id)?.id ?? null : null, loginId: id, success: false, reason, ip: '198.51.100.23', userAgent: ua[3], createdAt: new Date(now.getTime() - (i + 1) * 3600000) }));
  await prisma.loginLog.createMany({ data: loginRows });
  const auditRows: Array<{ actorId: string; action: string; targetType: string; targetId: string | null; diff: object; ip: string; userAgent: string; result: string; createdAt: Date }> = [];
  const aud = (actorId: string, action: string, targetType: string, targetId: string | null, diff: object, hoursAgo: number, result = 'SUCCESS') =>
    auditRows.push({ actorId, action, targetType, targetId, diff, ip: '203.0.113.50', userAgent: ua[0], result, createdAt: new Date(now.getTime() - hoursAgo * 3600000) });
  for (const t of teachers) {
    aud(t.id, 'journal.grade_create', 'Grade', null, { type: 'MIDTERM', note: 'demo activity' }, 24 * (t.n % 9) + 3);
    aud(t.id, 'attendance.mark', 'Attendance', null, { classes: 1, note: 'demo activity' }, 24 * (t.n % 5) + 5);
    if (t.n % 3 === 0) aud(t.id, 'assignment.create', 'Assignment', null, { note: 'demo activity' }, 24 * (t.n % 7) + 9);
    if (t.n % 4 === 0) aud(t.id, 'journal.publish', 'Grade', null, { note: 'demo activity' }, 24 * (t.n % 6) + 12);
  }
  for (const s of students.slice(0, 12)) aud(s.id, 'submission.submit', 'Submission', null, { note: 'demo activity' }, 24 * (s.n % 8) + 2);
  aud(admin.id, 'announcement.create', 'Announcement', null, { title: 'Welcome to the new semester' }, 24 * 14);
  aud(admin.id, 'calendar.create', 'CalendarEvent', null, { title: 'Midterm week' }, 24 * 12);
  aud(admin.id, 'user.update', 'User', students[0].id, { old: { phone: null }, new: { phone: '—' } }, 24 * 6);
  aud(admin.id, 'request.status_change', 'Request', null, { from: 'PENDING', to: 'APPROVED' }, 24 * 3);
  aud(students[6].id, 'auth.permission_denied', 'Route', '/api/v1/admin/users', { reason: 'role' }, 30, 'DENIED');
  aud(students[6].id, 'auth.permission_denied', 'Route', '/api/v1/timetable/jobs', { reason: 'role' }, 29, 'DENIED');
  await prisma.auditLog.createMany({ data: auditRows });
  log(`  ✓ demo activity: ${loginRows.length} login events, ${auditRows.length} audit entries`);

  const exams = await seedExams(prisma, {
    R, now, hash, email, students, teachers, subj, groups: GROUPS.map((g) => ({ name: g.name, semester: g.semester, sp: { id: g.sp.id, track: g.sp.track } })),
    groupSubjects: GROUP_SUBJECTS, rooms: rooms.map((r) => ({ id: r.id, code: r.code })), adminId: admin.id, semesterCodes, period: DEMO_PERIOD,
  }, log);

  return { exams, students: students.length, teachers: teachers.length, groups: GROUPS.length, subjects: subj.size, rooms: rooms.length, scheduleSlots: placed.length, grades: gradeRows.length, attendance: attUnique.length };
}
