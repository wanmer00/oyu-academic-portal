import { Module } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import {
  AcceptLanguageResolver,
  HeaderResolver,
  I18nModule,
  QueryResolver,
} from 'nestjs-i18n';
import * as path from 'path';

import { env } from './config/env';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { PrismaModule } from './infrastructure/prisma/prisma.module';
import { AIModule } from './modules/ai/ai.module';
import { AssignmentsModule } from './modules/assignments/assignments.module';
import { AuthModule } from './modules/auth/auth.module';
import { AttendanceModule } from './modules/attendance/attendance.module';
import { PermissionsGuard } from './common/rbac/permissions.guard';
import { RbacModule } from './common/rbac/permissions.service';
import { ScopeModule } from './common/rbac/scope.service';
import { OrgScopeModule } from './common/rbac/org-scope.service';
import { AuditTrailModule } from './common/audit/audit-trail.service';
import { SettingsModule } from './modules/admin/settings.service';
import { TimetableModule } from './modules/timetable/timetable.module';
import { DemoModule } from './demo/demo.module';
import { SystemModule } from './modules/system/system.module';
import { OrgModule } from './modules/org/org.module';
import { ViewAsModule } from './modules/view-as/view-as.module';
import { ViewAsGuard } from './modules/view-as/view-as.guard';
import { SuperAdminAuditInterceptor } from './modules/view-as/super-admin-audit.interceptor';
import { AnnouncementsModule } from './modules/announcements/announcements.module';
import { CalendarModule } from './modules/calendar/calendar.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { JournalModule } from './modules/journal/journal.module';
import { PeriodModule } from './modules/journal/period.service';
import { HealthModule } from './modules/health/health.module';
import { AdminModule } from './modules/admin/admin.module';
import { MaterialsModule } from './modules/materials/materials.module';
import { RequestsModule } from './modules/requests/requests.module';
import { AuditModule } from './modules/audit/audit.module';
import { StudentsModule } from './modules/students/students.module';
import { TeachersModule } from './modules/teachers/teachers.module';
import { TeacherAccessModule } from './modules/teachers/teacher-access.service';
import { UsersModule } from './modules/users/users.module';
import { ExamsModule } from './modules/exams/exams.module';

@Module({
  imports: [
    ThrottlerModule.forRoot([
      { ttl: env.RATE_LIMIT_WINDOW_MS, limit: env.RATE_LIMIT_MAX },
    ]),
    I18nModule.forRoot({
      fallbackLanguage: 'az',
      loaderOptions: {
        path: path.join(__dirname, '/i18n/'),
        watch: env.NODE_ENV !== 'production',
      },
      resolvers: [
        new HeaderResolver(['x-lang']),
        new QueryResolver(['lang']),
        AcceptLanguageResolver,
      ],
    }),
    PrismaModule,
    RbacModule,
    ScopeModule,
    OrgScopeModule,
    AuditTrailModule,
    SettingsModule,
    AuthModule,
    UsersModule,
    StudentsModule,
    TeacherAccessModule,
  PeriodModule,
    TeachersModule,
  JournalModule,
    AttendanceModule,
    TimetableModule,
    DemoModule,
    ViewAsModule,
    SystemModule,
    OrgModule,
    ExamsModule,
    AdminModule,
    AuditModule,
    AssignmentsModule,
    MaterialsModule,
    RequestsModule,
    CalendarModule,
    AnnouncementsModule,
    PaymentsModule,
    NotificationsModule,
    HealthModule,
    AIModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: ViewAsGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
    { provide: APP_INTERCEPTOR, useClass: SuperAdminAuditInterceptor },
  ],
})
export class AppModule {}
