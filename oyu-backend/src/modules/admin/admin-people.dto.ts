import { PermissionScope, Role, StudyLevel, UserStatus } from '@prisma/client';
import { z } from 'zod';

const str = (min: number, max: number) => z.string().trim().min(min).max(max);
const loginId = z.string().trim().regex(/^\d{10}$/, 'Login ID must be 10 digits');
const email = z.string().trim().toLowerCase().email().max(120);
const phone = z.string().trim().max(30);
const lang = z.enum(['az', 'ru', 'en']);
const reason = str(3, 500);
/** Пароль, заданный вручную: ≥ 10 символов, буквы и цифры. Если не задан — генерируется одноразовый. */
const password = z
  .string()
  .min(10)
  .max(100)
  .regex(/[A-Za-z]/, 'Password needs a letter')
  .regex(/\d/, 'Password needs a digit');

export const UsersQuerySchema = z.object({
  role: z.nativeEnum(Role).optional(),
  status: z.nativeEnum(UserStatus).optional(),
  search: z.string().trim().max(80).optional(),
  locked: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
  take: z.coerce.number().int().min(1).max(200).optional(),
  cursor: z.string().max(40).optional(),
});

/** Создание пользователей без профиля студента/преподавателя */
export const CreateUserSchema = z
  .object({
    role: z.enum(['ADMIN', 'SUPER_ADMIN', 'PROCTOR']),
    fullName: str(2, 120),
    email,
    loginId: loginId.optional(),
    phone: phone.optional(),
    preferredLang: lang.optional(),
    password: password.optional(),
  })
  .strict();

export const UpdateUserSchema = z
  .object({ fullName: str(2, 120).optional(), email: email.optional(), phone: phone.nullable().optional(), preferredLang: lang.optional() })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');

export const ReasonSchema = z.object({ reason }).strict();
export const OptionalReasonSchema = z.object({ reason: reason.optional() }).strict();
export const ChangeRoleSchema = z.object({ role: z.nativeEnum(Role), reason }).strict();
export const ResetPasswordSchema = z.object({ password: password.optional() }).strict();

// ── Students ──
export const StudentsQuerySchema = z.object({
  search: z.string().trim().max(80).optional(),
  groupName: z.string().trim().max(50).optional(),
  course: z.coerce.number().int().min(1).max(8).optional(),
  status: z.enum(['ACTIVE', 'SUSPENDED', 'ARCHIVED', 'DELETED']).optional(),
  take: z.coerce.number().int().min(1).max(200).optional(),
  cursor: z.string().max(40).optional(),
});

const studentFields = {
  faculty: str(2, 120),
  specialty: str(2, 120),
  groupName: str(1, 50),
  course: z.number().int().min(1).max(8),
  semester: z.number().int().min(1).max(16),
  level: z.nativeEnum(StudyLevel),
  birthDate: z.string().date().nullable().optional(),
};

export const CreateStudentSchema = z
  .object({ fullName: str(2, 120), email, loginId: loginId.optional(), phone: phone.optional(), preferredLang: lang.optional(), password: password.optional(), ...studentFields })
  .strict();

export const UpdateStudentSchema = z
  .object({
    fullName: str(2, 120).optional(),
    email: email.optional(),
    phone: phone.nullable().optional(),
    faculty: studentFields.faculty.optional(),
    specialty: studentFields.specialty.optional(),
    groupName: studentFields.groupName.optional(),
    course: studentFields.course.optional(),
    semester: studentFields.semester.optional(),
    level: studentFields.level.optional(),
    birthDate: studentFields.birthDate,
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');


// ── Teachers ──
export const TeachersQuerySchema = z.object({
  search: z.string().trim().max(80).optional(),
  department: z.string().trim().max(120).optional(),
  status: z.enum(['ACTIVE', 'SUSPENDED', 'ARCHIVED', 'DELETED']).optional(),
});

const teacherFields = { department: str(2, 120), title: str(2, 80), experience: z.number().int().min(0).max(70) };
export const CreateTeacherSchema = z
  .object({ fullName: str(2, 120), email, loginId: loginId.optional(), phone: phone.optional(), preferredLang: lang.optional(), password: password.optional(), ...teacherFields })
  .strict();
export const UpdateTeacherSchema = z
  .object({ fullName: str(2, 120).optional(), email: email.optional(), phone: phone.nullable().optional(), department: teacherFields.department.optional(), title: teacherFields.title.optional(), experience: teacherFields.experience.optional() })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');

export const AssignTeacherSchema = z
  .object({
    subjectCode: str(2, 20),
    groupName: str(1, 50),
    type: z.enum(['lecture', 'seminar', 'lab', 'exam']).optional(),
    academicYear: z.string().regex(/^\d{4}-\d{4}$/).optional(),
    term: z.enum(['FALL', 'SPRING', 'SUMMER']).optional(),
  })
  .strict();

// ── Groups ──
export const RenameGroupSchema = z.object({ newName: str(1, 50).refine((v) => !/[\u0000-\u001f]/.test(v), 'Invalid characters') }).strict();

// ── Subjects ──
export const SubjectsQuerySchema = z.object({ search: z.string().trim().max(80).optional(), active: z.enum(['true', 'false']).transform((v) => v === 'true').optional() });
export const CreateSubjectSchema = z
  .object({
    code: str(2, 20).regex(/^[A-Za-z0-9_-]+$/, 'Code: letters, digits, - and _'),
    name: str(2, 150),
    credits: z.number().int().min(1).max(30),
    semester: z.number().int().min(1).max(16),
    description: str(0, 1000).optional(),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  })
  .strict();
export const UpdateSubjectSchema = z
  .object({
    name: str(2, 150).optional(),
    credits: z.number().int().min(1).max(30).optional(),
    semester: z.number().int().min(1).max(16).optional(),
    description: str(0, 1000).nullable().optional(),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional(),
    isActive: z.boolean().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');

// ── Roles & settings ──
export const SetPermissionSchema = z
  .object({ role: z.nativeEnum(Role), permission: z.string().min(3).max(60), scope: z.nativeEnum(PermissionScope).nullable() })
  .strict();
export const SetSettingSchema = z.object({ value: z.number().finite() }).strict();

export type CreateUserDto = z.infer<typeof CreateUserSchema>;
export type UpdateUserDto = z.infer<typeof UpdateUserSchema>;
export type CreateStudentDto = z.infer<typeof CreateStudentSchema>;
export type UpdateStudentDto = z.infer<typeof UpdateStudentSchema>;
export type CreateTeacherDto = z.infer<typeof CreateTeacherSchema>;
export type UpdateTeacherDto = z.infer<typeof UpdateTeacherSchema>;
export type AssignTeacherDto = z.infer<typeof AssignTeacherSchema>;
export type CreateSubjectDto = z.infer<typeof CreateSubjectSchema>;
export type UpdateSubjectDto = z.infer<typeof UpdateSubjectSchema>;
export type StudentsQuery = z.infer<typeof StudentsQuerySchema>;
export type TeachersQuery = z.infer<typeof TeachersQuerySchema>;
export type SubjectsQuery = z.infer<typeof SubjectsQuerySchema>;
