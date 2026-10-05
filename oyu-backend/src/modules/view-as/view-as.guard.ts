import { CanActivate, ExecutionContext, ForbiddenException, Injectable, SetMetadata, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Role } from '@prisma/client';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';

export const SKIP_VIEW_AS_KEY = 'skipViewAs';
/** Маршрут всегда выполняется от имени реального пользователя (нужен для входа/выхода из режима просмотра) */
export const SkipViewAs = () => SetMetadata(SKIP_VIEW_AS_KEY, true);

/**
 * «Просмотреть как роль» (View as): только для SUPER_ADMIN.
 * Заголовок X-View-As: <userId> подменяет request.user на выбранного пользователя (его роль, права, данные),
 * НО режим строго «только чтение»: любой не-GET запрос отклоняется. Роль самого SUPER_ADMIN в БД и в токене не меняется;
 * реальный пользователь остаётся в request.actualUser и попадает в Audit Log.
 */
@Injectable()
export class ViewAsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector, private readonly prisma: PrismaService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest();
    const targetId = req.headers?.['x-view-as'];
    if (!targetId || !req.user) return true;
    if (this.reflector.getAllAndOverride<boolean>(SKIP_VIEW_AS_KEY, [ctx.getHandler(), ctx.getClass()])) return true;
    if (req.user.role !== Role.SUPER_ADMIN) throw new ForbiddenException({ message: 'Only SUPER_ADMIN can use View as', code: 'VIEW_AS_FORBIDDEN' });
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      throw new ForbiddenException({ message: 'View-as mode is read-only. Exit the preview to make changes.', code: 'VIEW_AS_READ_ONLY' });
    }
    const target = await this.prisma.user.findUnique({ where: { id: String(targetId) }, include: { student: true, teacher: true } });
    if (!target || target.status !== 'ACTIVE' || target.role === Role.SUPER_ADMIN) throw new UnauthorizedException({ message: 'Invalid view-as target', code: 'VIEW_AS_INVALID' });
    const { passwordHash, totpSecret, ...safe } = target;
    req.actualUser = req.user;
    req.user = safe;
    req.viewAs = true;
    ctx.switchToHttp().getResponse().setHeader('X-View-As', safe.loginId);
    return true;
  }
}