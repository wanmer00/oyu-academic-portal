import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Request, Response } from 'express';
import { I18n, I18nContext } from 'nestjs-i18n';

import { Public } from '../../common/decorators/public.decorator';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { env } from '../../config/env';
import { AuthService, parseDuration } from './auth.service';
import { LoginDto, LoginSchema } from './dto';

const REFRESH_COOKIE = 'ap_refresh';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  // ── POST /api/v1/auth/login ──
  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: env.RATE_LIMIT_AUTH_MAX, ttl: 60_000 } })
  async login(
    @Body(new ZodValidationPipe(LoginSchema)) dto: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @I18n() i18n: I18nContext,
  ) {
    const result = await this.authService.login(dto, {
      ip: this.getIp(req),
      userAgent: req.headers['user-agent'] ?? null,
      i18n,
    });
    this.setRefreshCookie(res, result.refreshToken);
    return {
      accessToken: result.accessToken,
      user: result.user,
    };
  }

  // ── POST /api/v1/auth/refresh ──
  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @I18n() i18n: I18nContext,
  ) {
    const token = req.cookies?.[REFRESH_COOKIE];
    const result = await this.authService.refresh(token, {
      ip: this.getIp(req),
      userAgent: req.headers['user-agent'] ?? null,
      i18n,
    });
    this.setRefreshCookie(res, result.refreshToken);
    return {
      accessToken: result.accessToken,
      user: result.user,
    };
  }

  // ── POST /api/v1/auth/logout ──
  @Public() // работает и с истёкшим access-токеном: важно всегда очистить cookie
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const token = req.cookies?.[REFRESH_COOKIE];
    if (token) await this.authService.logout(token);
    res.clearCookie(REFRESH_COOKIE, {
      path: '/api/v1/auth',
      httpOnly: true,
      secure: env.COOKIE_SECURE,
      sameSite: env.COOKIE_SAMESITE,
    });
  }

  // ── helpers ──
  private setRefreshCookie(res: Response, token: string) {
    res.cookie(REFRESH_COOKIE, token, {
      httpOnly: true,
      secure: env.COOKIE_SECURE,
      sameSite: env.COOKIE_SAMESITE,
      maxAge: parseDuration(env.JWT_REFRESH_TTL), // совпадает со сроком токена в БД
      path: '/api/v1/auth',
    });
  }

  // req.ip уже учитывает доверенный прокси (trust proxy = 1); сырой X-Forwarded-For клиент может подделать
  private getIp(req: Request): string | null {
    return req.ip || null;
  }
}
