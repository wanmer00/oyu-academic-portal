import { Body, Controller, Get, Patch } from '@nestjs/common';
import { z } from 'zod';
import { CurrentUser, CurrentUserData } from '../../common/decorators/current-user.decorator';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { PermissionsService } from '../../common/rbac/permissions.service';
import { UsersService } from './users.service';
import { OrgScopeService } from '../../common/rbac/org-scope.service';

const UpdateMeSchema = z
  .object({
    phone: z.string().max(50).optional(),
    preferredLang: z.enum(['az', 'ru', 'en']).optional(),
  })
  .strict();

type UpdateMeDto = z.infer<typeof UpdateMeSchema>;

@Controller('me')
export class UsersController {
  constructor(
    private readonly users: UsersService,
    private readonly perms: PermissionsService,
    private readonly org: OrgScopeService,
  ) {}

  /** Профиль + карта прав роли {permission: scope} — frontend использует её только для показа/скрытия интерфейса */
  @Get()
  async me(@CurrentUser() user: CurrentUserData) {
    const os = await this.org.forUser(user);
    return { ...this.users.toPublicUser(user), permissions: await this.perms.forRole(user.role), orgScope: { kind: os.kind, position: os.position, label: os.label } };
  }

  @Patch()
  update(
    @CurrentUser() user: CurrentUserData,
    @Body(new ZodValidationPipe(UpdateMeSchema)) dto: UpdateMeDto,
  ) {
    return this.users.updateMe(user.id, dto);
  }
}
