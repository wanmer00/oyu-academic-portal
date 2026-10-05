import { Body, Controller, Get, Post, Req } from '@nestjs/common';
import { Role } from '@prisma/client';
import { Request } from 'express';
import { z } from 'zod';
import { AuditTrailService } from '../../common/audit/audit-trail.service';
import { CurrentUser, CurrentUserData } from '../../common/decorators/current-user.decorator';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { RequirePermission } from '../../common/rbac/require-permission.decorator';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { SkipViewAs } from './view-as.guard';

const Body_ = z.object({ userId: z.string().min(1).max(40) }).strict();
const PREVIEW_ROLES: Role[] = [Role.ADMIN, Role.TEACHER, Role.STUDENT];

/** Вход/выход из режима «Просмотреть как роль» — всегда от имени реального SUPER_ADMIN, с записью в Audit Log */
@Controller('admin/view-as')
@SkipViewAs()
@RequirePermission('roles.update', { requireAll: true })
export class ViewAsController {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditTrailService) {}

  @Get('targets')
  async targets() {
    const out: Array<{ role: Role; users: Array<{ id: string; loginId: string; fullName: string }> }> = [];
    for (const role of PREVIEW_ROLES) {
      out.push({ role, users: await this.prisma.user.findMany({ where: { role, status: 'ACTIVE', deletedAt: null }, select: { id: true, loginId: true, fullName: true }, orderBy: { loginId: 'asc' }, take: 60 }) });
    }
    return { roles: out };
  }

  @Post('start')
  async start(@CurrentUser() u: CurrentUserData, @Body(new ZodValidationPipe(Body_)) dto: z.infer<typeof Body_>, @Req() req: Request) {
    const t = await this.prisma.user.findFirst({ where: { id: dto.userId, status: 'ACTIVE', role: { in: PREVIEW_ROLES } }, select: { id: true, loginId: true, fullName: true, role: true } });
    if (!t) return { ok: false };
    await this.audit.record({ actorId: u.id, action: 'rbac.view_as_start', targetType: 'User', targetId: t.id, new: { role: t.role, loginId: t.loginId }, extra: { readOnly: true } }, { ip: req.ip ?? null, userAgent: (req.headers['user-agent'] as string) ?? null });
    return { ok: true, target: t };
  }

  @Post('end')
  async end(@CurrentUser() u: CurrentUserData, @Body(new ZodValidationPipe(Body_.partial())) dto: Partial<z.infer<typeof Body_>>, @Req() req: Request) {
    await this.audit.record({ actorId: u.id, action: 'rbac.view_as_end', targetType: 'User', targetId: dto.userId ?? null }, { ip: req.ip ?? null, userAgent: (req.headers['user-agent'] as string) ?? null });
    return { ok: true };
  }
}