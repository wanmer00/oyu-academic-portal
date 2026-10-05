import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { Request } from 'express';
import { z } from 'zod';
import { CurrentUser, CurrentUserData } from '../../common/decorators/current-user.decorator';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { RequirePermission } from '../../common/rbac/require-permission.decorator';
import { AdminUsersService } from './admin-users.service';
import { OrgScopeService } from '../../common/rbac/org-scope.service';
import { ChangeRoleSchema, CreateUserSchema, OptionalReasonSchema, ReasonSchema, ResetPasswordSchema, UpdateUserSchema, UsersQuerySchema } from './admin-people.dto';

type Q<T extends z.ZodTypeAny> = z.infer<T>;
const ctxOf = (req: Request) => ({ ip: req.ip ?? null, userAgent: (req.headers['user-agent'] as string) ?? null });
const id = new ZodValidationPipe(z.string().min(1).max(40));
const ALL = { requireAll: true } as const;

/** Admin Panel → Users. Все операции проверяют право (PermissionsGuard) и правила иерархии (AdminUsersService). */
@Controller('admin/users')
export class AdminUsersController {
  constructor(private readonly users: AdminUsersService, private readonly org: OrgScopeService) {}
  private async scope(u: CurrentUserData, uid: string) { await this.users.assertInScope((await this.org.forUser(u)).groups, uid); }

  @Get()
  @RequirePermission('users.view', ALL)
  async list(@CurrentUser() u: CurrentUserData, @Query(new ZodValidationPipe(UsersQuerySchema)) q: Q<typeof UsersQuerySchema>) {
    return this.users.list(q, (await this.org.forUser(u)).groups);
  }

  @Get(':id')
  @RequirePermission('users.view', ALL)
  async get(@CurrentUser() u: CurrentUserData, @Param('id', id) uid: string) {
    await this.scope(u, uid);
    return this.users.get(uid);
  }

  @Post()
  @RequirePermission('users.create', ALL)
  create(@CurrentUser() u: CurrentUserData, @Body(new ZodValidationPipe(CreateUserSchema)) dto: Q<typeof CreateUserSchema>, @Req() req: Request) {
    return this.users.create(u, dto, ctxOf(req));
  }

  @Patch(':id')
  @RequirePermission('users.update', ALL)
  async update(@CurrentUser() u: CurrentUserData, @Param('id', id) uid: string, @Body(new ZodValidationPipe(UpdateUserSchema)) dto: Q<typeof UpdateUserSchema>, @Req() req: Request) {
    await this.scope(u, uid);
    return this.users.update(u, uid, dto, ctxOf(req));
  }

  @Post(':id/block')
  @RequirePermission('users.block', ALL)
  async block(@CurrentUser() u: CurrentUserData, @Param('id', id) uid: string, @Body(new ZodValidationPipe(ReasonSchema)) dto: Q<typeof ReasonSchema>, @Req() req: Request) {
    await this.scope(u, uid);
    return this.users.block(u, uid, dto.reason, ctxOf(req));
  }

  @Post(':id/unblock')
  @RequirePermission('users.block', ALL)
  async unblock(@CurrentUser() u: CurrentUserData, @Param('id', id) uid: string, @Req() req: Request) {
    await this.scope(u, uid);
    return this.users.unblock(u, uid, ctxOf(req));
  }

  @Post(':id/reset-password')
  @RequirePermission('users.update', ALL)
  async resetPassword(@CurrentUser() u: CurrentUserData, @Param('id', id) uid: string, @Body(new ZodValidationPipe(ResetPasswordSchema)) dto: Q<typeof ResetPasswordSchema>, @Req() req: Request) {
    await this.scope(u, uid);
    return this.users.resetPassword(u, uid, dto.password, ctxOf(req));
  }

  @Post(':id/restore')
  @RequirePermission('users.delete', ALL)
  async restore(@CurrentUser() u: CurrentUserData, @Param('id', id) uid: string, @Req() req: Request) {
    await this.scope(u, uid);
    return this.users.restore(u, uid, ctxOf(req));
  }

  @Delete(':id')
  @RequirePermission('users.delete', ALL)
  async remove(@CurrentUser() u: CurrentUserData, @Param('id', id) uid: string, @Body(new ZodValidationPipe(OptionalReasonSchema)) dto: Q<typeof OptionalReasonSchema>, @Req() req: Request) {
    await this.scope(u, uid);
    return this.users.remove(u, uid, dto.reason, ctxOf(req));
  }

  @Patch(':id/role')
  @RequirePermission('roles.assign', ALL)
  async changeRole(@CurrentUser() u: CurrentUserData, @Param('id', id) uid: string, @Body(new ZodValidationPipe(ChangeRoleSchema)) dto: Q<typeof ChangeRoleSchema>, @Req() req: Request) {
    await this.scope(u, uid);
    return this.users.changeRole(u, uid, dto.role, dto.reason, ctxOf(req));
  }
}
