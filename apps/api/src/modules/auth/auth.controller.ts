import { Body, Controller, Get, HttpCode, Ip, Post } from '@nestjs/common';
import { IsOptional, IsString, MinLength } from 'class-validator';
import { AuthService } from './auth.service';
import { PrismaService } from '../../prisma/prisma.service';
import { CurrentUser } from '../../common/current-user.decorator';
import type { AuthUser } from '../../common/current-user.decorator';
import { Roles } from '../../common/roles.guard';

const LOGGED_IN_ROLES = ['OWNER', 'REP', 'CLERK', 'WAREHOUSE', 'CUSTOMER'] as const;

class LoginDto {
  @IsString() username!: string;
  @IsString() @MinLength(6) password!: string;
  /** 租户编码。同名账号分属多个租户时必填; 用户名全局唯一时可以不传(兼容旧客户端)。 */
  @IsOptional() @IsString() tenantCode?: string;
}

class LogoutDto {
  @IsOptional() @IsString() reason?: string;
}

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly prisma: PrismaService,
  ) {}

  @Post('login')
  @HttpCode(200)
  async login(@Body() dto: LoginDto, @Ip() ip: string): Promise<unknown> {
    return this.auth.login(dto.username, dto.password, ip, dto.tenantCode);
  }

  @Get('me')
  @Roles(...LOGGED_IN_ROLES)
  async me(@CurrentUser() user: AuthUser): Promise<AuthUser> {
    return user;
  }

  /** 登出 = 吊销本用户全部令牌(B1: 立即生效)。五种已登录角色都可调用。 */
  @Post('logout')
  @Roles(...LOGGED_IN_ROLES)
  @HttpCode(200)
  async logout(@CurrentUser() user: AuthUser, @Body() dto: LogoutDto): Promise<{ ok: boolean }> {
    await this.auth.revokeTokens(user.id, dto.reason ?? 'logout');
    return { ok: true };
  }
}
