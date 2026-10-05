import { Body, Controller, Get, Param, Patch, Put, Req } from '@nestjs/common';
import { Request } from 'express';
import { z } from 'zod';
import { CurrentUser, CurrentUserData } from '../../common/decorators/current-user.decorator';
import { AuditTrailService } from '../../common/audit/audit-trail.service';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { PermissionsService } from '../../common/rbac/permissions.service';
import { RequirePermission } from '../../common/rbac/require-permission.decorator';
import { SetPermissionSchema, SetSettingSchema } from './admin-people.dto';
import { SettingsService } from './settings.service';

type Q<T extends z.ZodTypeAny> = z.infer<T>;
const ctxOf = (req: Request) => ({ ip: req.ip ?? null, userAgent: (req.headers['user-agent'] as string) ?? null });
const ALL = { requireAll: true } as const;

/** Admin Panel → Roles & Permissions и Settings */
@Controller('admin')
export class AdminRolesController {
  constructor(
    private readonly perms: PermissionsService,
    private readonly audit: AuditTrailService,
    private readonly settings: SettingsService,
  ) {}

  /** Матрица «роль × право → scope» и каталог прав */
  @Get('roles')
  @RequirePermission('roles.view', ALL)
  matrix() {
    return this.perms.matrix();
  }

  /** Задать/снять право роли. scope=null снимает право. Только roles.update (по умолчанию — SUPER_ADMIN). */
  @Put('roles/permissions')
  @RequirePermission('roles.update', ALL)
  async setPermission(@CurrentUser() u: CurrentUserData, @Body(new ZodValidationPipe(SetPermissionSchema)) dto: Q<typeof SetPermissionSchema>, @Req() req: Request) {
    const r = await this.perms.setPermission(u.id, dto.role, dto.permission, dto.scope);
    await this.audit.record({ actorId: u.id, action: 'rbac.permission_set', targetType: 'RolePermission', targetId: `${dto.role}:${dto.permission}`, old: r.before, new: r.after, extra: { role: dto.role, permission: dto.permission } }, ctxOf(req));
    return r;
  }

  @Get('settings')
  @RequirePermission('settings.view', ALL)
  listSettings() {
    return this.settings.list();
  }

  @Patch('settings/:key')
  @RequirePermission('settings.update', ALL)
  setSetting(@CurrentUser() u: CurrentUserData, @Param('key', new ZodValidationPipe(z.string().min(3).max(60))) key: string, @Body(new ZodValidationPipe(SetSettingSchema)) dto: Q<typeof SetSettingSchema>, @Req() req: Request) {
    return this.settings.set(u.id, key, dto.value, ctxOf(req));
  }
}
