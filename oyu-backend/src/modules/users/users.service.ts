import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  toPublicUser(user: any) {
    if (!user) return null;
    const { passwordHash, totpSecret, ...safe } = user;
    return safe;
  }

  async getById(id: string) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      include: { student: true, teacher: true },
    });
    return this.toPublicUser(user);
  }

  async updateMe(
    userId: string,
    dto: { phone?: string; preferredLang?: 'az' | 'ru' | 'en' },
  ) {
    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: dto,
      include: { student: true, teacher: true },
    });
    return this.toPublicUser(updated);
  }
}
