import { SetMetadata, createParamDecorator, ExecutionContext } from '@nestjs/common';
import { PermissionScope } from '@prisma/client';
import { Grant } from './permissions.service';

export const PERMISSION_KEY = 'ap:permission';

export interface PermissionMeta {
  permission: string;
  /** Обработчик не умеет ограничивать данные — требуется scope ALL (иначе 403) */
  requireAll?: boolean;
  /** Допустимые scope (например, функция только для студента: ['OWN']) */
  scopes?: PermissionScope[];
}

/**
 * Проверка права на backend (PermissionsGuard). Роль — только источник набора прав;
 * решение принимается по праву и его scope, которые сервисы применяют к данным.
 */
export const RequirePermission = (permission: string, opts: { requireAll?: boolean; scopes?: PermissionScope[] } = {}) =>
  SetMetadata(PERMISSION_KEY, { permission, requireAll: !!opts.requireAll, scopes: opts.scopes } as PermissionMeta);

/** Право, разрешённое для текущего запроса (с его scope) */
export const CurrentGrant = createParamDecorator((_d: unknown, ctx: ExecutionContext): Grant => ctx.switchToHttp().getRequest().grant);

