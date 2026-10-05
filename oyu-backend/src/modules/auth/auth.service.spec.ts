import { describe, expect, it, vi } from 'vitest';
import { AuthService, parseDuration } from './auth.service';

const i18n = { t: (k: string) => k } as any;
const ctx = { ip: '1.1.1.1', userAgent: 'ua', i18n };

function svc(stored: any, newerInFamily = 0) {
  const prisma: any = {
    refreshToken: {
      findUnique: vi.fn().mockResolvedValue(stored),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      count: vi.fn().mockResolvedValue(newerInFamily),
      create: vi.fn().mockResolvedValue({}),
    },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  };
  const jwt: any = { sign: vi.fn().mockReturnValue('access') };
  return { s: new AuthService(prisma, jwt), prisma };
}
const user = { id: 'u1', role: 'STUDENT', loginId: 'x', status: 'ACTIVE', passwordHash: 'h', totpSecret: null };

describe('parseDuration', () => {
  it('parses units', () => {
    expect(parseDuration('15m')).toBe(900_000);
    expect(parseDuration('7d')).toBe(604_800_000);
  });
});

describe('AuthService.refresh', () => {
  it('rotates a valid token and never returns it in a form other than the raw cookie value', async () => {
    const { s, prisma } = svc({ id: 't', family: 'f', revokedAt: null, expiresAt: new Date(Date.now() + 1e6), user });
    const r = await s.refresh('tok', ctx);
    expect(r.accessToken).toBe('access');
    expect(r.user).not.toHaveProperty('passwordHash');
    expect(r.user).not.toHaveProperty('totpSecret');
    expect(prisma.refreshToken.create.mock.calls[0][0].data.family).toBe('f');
  });
  it('a token revoked seconds ago by a parallel tab → 401 without revoking the family', async () => {
    const { s, prisma } = svc({ id: 't', family: 'f', revokedAt: new Date(Date.now() - 2000), expiresAt: new Date(Date.now() + 1e6), userId: 'u1', user }, 1);
    await expect(s.refresh('tok', ctx)).rejects.toThrow('auth.invalid_refresh_token');
    expect(prisma.refreshToken.updateMany).not.toHaveBeenCalled();
  });
  it('real reuse (old revoked token) → whole family revoked + audit', async () => {
    const { s, prisma } = svc({ id: 't', family: 'f', revokedAt: new Date(Date.now() - 3_600_000), expiresAt: new Date(Date.now() + 1e6), userId: 'u1', user }, 1);
    await expect(s.refresh('tok', ctx)).rejects.toThrow('auth.refresh_reuse_detected');
    expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({ where: { family: 'f', revokedAt: null }, data: expect.anything() });
    expect(prisma.auditLog.create).toHaveBeenCalled();
  });
  it('revoked at logout (no newer token in family) within grace → still treated as reuse', async () => {
    const { s } = svc({ id: 't', family: 'f', revokedAt: new Date(Date.now() - 1000), expiresAt: new Date(Date.now() + 1e6), userId: 'u1', user }, 0);
    await expect(s.refresh('tok', ctx)).rejects.toThrow('auth.refresh_reuse_detected');
  });
  it('expired / missing tokens are rejected', async () => {
    await expect(svc({ id: 't', family: 'f', revokedAt: null, expiresAt: new Date(Date.now() - 1), user }).s.refresh('tok', ctx)).rejects.toThrow('auth.refresh_expired');
    await expect(svc(null).s.refresh(undefined, ctx)).rejects.toThrow('auth.no_refresh_token');
  });
});
