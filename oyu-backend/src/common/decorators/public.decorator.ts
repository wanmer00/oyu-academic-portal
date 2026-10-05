import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';
/**
 * Пометить endpoint как публичный (обход JwtAuthGuard).
 * Использовать только для /auth/login, /auth/refresh, /health.
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
