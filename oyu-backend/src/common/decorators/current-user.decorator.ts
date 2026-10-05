import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { Role } from '@prisma/client';

export interface CurrentUserData {
  id: string;
  loginId: string;
  email: string;
  role: Role;
  fullName: string;
  preferredLang: string;
  student?: any;
  teacher?: any;
}

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): CurrentUserData => {
    return ctx.switchToHttp().getRequest().user;
  },
);
