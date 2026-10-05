import { BadRequestException, ForbiddenException, Global, Injectable, Logger, Module, OnModuleInit } from '@nestjs/common';
import { PermissionScope, Role } from '@prisma/client';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { DEFAULT_MATRIX, PERMISSION_BY_KEY, PERMISSION_CATALOG, PERMISSION_KEYS } from './permissions';

const SEEDED_KEYS = 'rbac.seededKeys';
const TTL_MS = 60_000;

export interface Grant {
  permission: string;
  scope: PermissionScope;
}

/**
 * Права ролей. Значения по умолчанию записываются в RolePermission при старте — только для ключей,
 * которых система ещё не видела (то, что SUPER_ADMIN убрал вручную, не возвращается).
 * SUPER_ADMIN всегда имеет все права со scope ALL независимо от БД (защита от блокировки системы).
 */
@Injectable()
export class PermissionsService implements OnModuleInit {
  private readonly log = new Logger('RBAC');
  private cache = new Map<Role, Map<string, PermissionScope>>();
  private loadedAt = 0;

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit() {
    await this.syncDefaults();
    await this.reload();
  }

  /** Добавляет в БД дефолтные права для новых ключей каталога */
  async syncDefaults() {
    const seededRow = await this.prisma.systemSetting.findUnique({ where: { key: SEEDED_KEYS } });
    const seeded = new Set<string>(Array.isArray(seededRow?.value) ? (seededRow!.value as string[]) : []);
    const fresh = PERMISSION_KEYS.filter((k) => !seeded.has(k));
    if (!fresh.length) return;
    const rows: Array<{ role: Role; permission: string; scope: PermissionScope }> = [];
    for (const role of Object.keys(DEFAULT_MATRIX) as Role[]) {
      for (const permission of fresh) {
        const scope = DEFAULT_MATRIX[role][permission];
        if (scope) rows.push({ role, permission, scope });
      }
    }
    await this.prisma.$transaction([
      this.prisma.rolePermission.createMany({ data: rows, skipDuplicates: true }),
      this.prisma.systemSetting.upsert({
        where: { key: SEEDED_KEYS },
        create: { key: SEEDED_KEYS, value: PERMISSION_KEYS },
        update: { value: PERMISSION_KEYS },
      }),
    ]);
    this.log.log(`Default permissions synced (${fresh.length} new keys, ${rows.length} rows)`);
  }

  async reload() {
    const rows = await this.prisma.rolePermission.findMany();
    const next = new Map<Role, Map<string, PermissionScope>>();
    for (const r of rows) {
      if (!PERMISSION_BY_KEY.has(r.permission)) continue; // устаревший ключ
      (next.get(r.role) ?? next.set(r.role, new Map()).get(r.role)!).set(r.permission, r.scope);
    }
    this.cache = next;
    this.loadedAt = Date.now();
  }

  invalidate() {
    this.loadedAt = 0;
  }

  private async ensureFresh() {
    if (Date.now() - this.loadedAt > TTL_MS) await this.reload();
  }

  /** Право роли или null */
  async grant(role: Role, permission: string): Promise<Grant | null> {
    // SUPER_ADMIN: любое право и любой scope — в том числе ключи, которых ещё нет в каталоге/матрице (будущий функционал)
    if (role === Role.SUPER_ADMIN) return { permission, scope: PermissionScope.ALL };
    await this.ensureFresh();
    const scope = this.cache.get(role)?.get(permission);
    return scope ? { permission, scope } : null;
  }

  /** Карта «право → scope» для роли (для /me/permissions и фронтенда) */
  async forRole(role: Role): Promise<Record<string, PermissionScope>> {
    if (role === Role.SUPER_ADMIN) return Object.fromEntries(PERMISSION_KEYS.map((k) => [k, PermissionScope.ALL]));
    await this.ensureFresh();
    return Object.fromEntries(this.cache.get(role) ?? []);
  }

  async has(role: Role, permission: string): Promise<boolean> {
    return !!(await this.grant(role, permission));
  }

  /** Бросает 403, если у роли нет права; возвращает grant со scope */
  async require(role: Role, permission: string): Promise<Grant> {
    const g = await this.grant(role, permission);
    if (!g) throw new ForbiddenException({ message: 'Insufficient permissions', code: 'PERMISSION_DENIED', permission });
    return g;
  }

  // ───────── управление матрицей (Roles & Permissions) ─────────
  async matrix() {
    await this.reload();
    const roles = Object.keys(DEFAULT_MATRIX) as Role[];
    const counts = await this.prisma.user.groupBy({ by: ['role'], _count: { _all: true } });
    return {
      catalog: PERMISSION_CATALOG,
      roles: roles.map((role) => ({
        role,
        users: counts.find((c) => c.role === role)?._count._all ?? 0,
        locked: role === Role.SUPER_ADMIN,
        permissions: role === Role.SUPER_ADMIN ? Object.fromEntries(PERMISSION_KEYS.map((k) => [k, PermissionScope.ALL])) : Object.fromEntries(this.cache.get(role) ?? []),
      })),
    };
  }

  /** Задать/снять право роли. scope=null — снять. SUPER_ADMIN изменять нельзя. */
  async setPermission(actorId: string, role: Role, permission: string, scope: PermissionScope | null) {
    if (role === Role.SUPER_ADMIN) throw new BadRequestException({ message: 'SUPER_ADMIN permissions are fixed', code: 'ROLE_LOCKED' });
    const def = PERMISSION_BY_KEY.get(permission);
    if (!def) throw new BadRequestException({ message: 'Unknown permission', code: 'UNKNOWN_PERMISSION' });
    if (scope && !def.scopes.includes(scope)) throw new BadRequestException({ message: `Scope ${scope} is not allowed for ${permission}`, code: 'SCOPE_NOT_ALLOWED', allowed: def.scopes });
    const before = (await this.grant(role, permission))?.scope ?? null;
    // Нельзя отобрать у ролей с admin-доступом возможность управлять правами: roles.update есть только у SUPER_ADMIN (зашит)
    if (scope) {
      await this.prisma.rolePermission.upsert({
        where: { role_permission: { role, permission } },
        create: { role, permission, scope, updatedBy: actorId },
        update: { scope, updatedBy: actorId },
      });
    } else {
      await this.prisma.rolePermission.deleteMany({ where: { role, permission } });
    }
    this.invalidate();
    return { before, after: scope };
  }
}

@Global()
@Module({ providers: [PermissionsService], exports: [PermissionsService] })
export class RbacModule {}
