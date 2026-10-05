import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Role } from '@prisma/client';
import { Observable, tap } from 'rxjs';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';

/**
 * Страховка Audit Log: каждое изменяющее действие (POST/PUT/PATCH/DELETE) реального SUPER_ADMIN
 * фиксируется общей записью, даже если у конкретного модуля нет собственной аудит-записи.
 * Подробные записи модулей (оценки, посещаемость, расписание, роли, права) остаются как были.
 */
@Injectable()
export class SuperAdminAuditInterceptor implements NestInterceptor {
  constructor(private readonly prisma: PrismaService) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = ctx.switchToHttp().getRequest();
    const writes = ['POST', 'PUT', 'PATCH', 'DELETE'];
    if (!req.user || req.user.role !== Role.SUPER_ADMIN || req.viewAs || !writes.includes(req.method)) return next.handle();
    const path = String(req.originalUrl ?? req.url).split('?')[0].slice(0, 200);
    if (path.includes('/auth/') || path.includes('/admin/view-as/')) return next.handle();
    return next.handle().pipe(
      tap(() => {
        void this.prisma.auditLog.create({
          data: { actorId: req.user.id, action: 'superadmin.request', targetType: 'HTTP', targetId: `${req.method} ${path}`, diff: { method: req.method, path }, ip: req.ip ?? null, userAgent: (req.headers?.['user-agent'] as string) ?? null },
        }).catch(() => undefined);
      }),
    );
  }
}