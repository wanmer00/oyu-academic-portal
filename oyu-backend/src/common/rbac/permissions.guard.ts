import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PermissionScope } from '@prisma/client';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { PERMISSION_KEY, PermissionMeta } from './require-permission.decorator';
import { PermissionsService } from './permissions.service';
import { OrgScopeService } from './org-scope.service';
import { PERMISSION_BY_KEY } from './permissions';

/**
 * Глобальный guard (после JwtAuthGuard). Если у маршрута есть @RequirePermission — проверяет право роли пользователя
 * и кладёт в request.grant {permission, scope}. Отказ записывается в AuditLog с result=DENIED.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly perms: PermissionsService,
    private readonly prisma: PrismaService,
    private readonly org: OrgScopeService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const meta = this.reflector.getAllAndOverride<PermissionMeta | undefined>(PERMISSION_KEY, [ctx.getHandler(), ctx.getClass()]);
    if (!meta) return true;

    const req = ctx.switchToHttp().getRequest();
    const user = req.user;
    if (!user) throw new ForbiddenException('No authenticated user');

    let grant = await this.perms.grant(user.role, meta.permission);
    // Руководство с областью (декан, зав. кафедрой, тьютор): ALL сужается до ASSIGNED там, где право это допускает.
    // Маршруты requireAll остаются ALL — их сервисы сами фильтруют данные по OrgScopeService.
    if (grant && grant.scope === PermissionScope.ALL && user.role === 'ADMIN' && !meta.requireAll && PERMISSION_BY_KEY.get(meta.permission)?.scopes.includes(PermissionScope.ASSIGNED)) {
      const os = await this.org.forUser(user);
      if (os.groups) grant = { ...grant, scope: PermissionScope.ASSIGNED };
    }
    const scopeOk = grant && (!meta.requireAll || grant.scope === PermissionScope.ALL) && (!meta.scopes || meta.scopes.includes(grant.scope));
    if (!grant || !scopeOk) {
      await this.deny(req, meta.permission);
      throw new ForbiddenException({ message: 'Insufficient permissions', code: 'PERMISSION_DENIED', permission: meta.permission });
    }
    req.grant = grant;
    return true;
  }

  private async deny(req: any, permission: string) {
    try {
      await this.prisma.auditLog.create({
        data: {
          actorId: req.user.id,
          action: 'auth.permission_denied',
          targetType: 'Permission',
          targetId: permission,
          diff: { permission, method: req.method, path: String(req.originalUrl ?? req.url).split('?')[0].slice(0, 200), role: req.user.role },
          result: 'DENIED',
          ip: req.ip ?? null,
          userAgent: (req.headers?.['user-agent'] as string) ?? null,
        },
      });
    } catch {
      /* отказ всё равно возвращается клиенту */
    }
  }
}
