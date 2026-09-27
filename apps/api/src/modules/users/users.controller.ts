import { BadRequestException, Body, Controller, Get, Injectable, Module, NotFoundException, Param, Post } from '@nestjs/common';
import { IsEnum, IsOptional, IsString, MinLength } from 'class-validator';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthService } from '../auth/auth.service';
import { AuditService, AuditAction } from '../../audit/audit.service';
import { Roles } from '../../common/roles.guard';
import { CurrentUser } from '../../common/current-user.decorator';
import type { AuthUser } from '../../common/current-user.decorator';

class CreateUserDto {
  @IsString() username!: string;
  @IsString() @MinLength(6) password!: string;
  @IsString() name!: string;
  @IsEnum(['OWNER', 'REP', 'CLERK', 'WAREHOUSE']) role!: 'OWNER' | 'REP' | 'CLERK' | 'WAREHOUSE';
  @IsOptional() @IsString() phone?: string;
}

@Controller('users')
export class UsersController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @Roles('OWNER', 'CLERK')
  async list(): Promise<unknown> {
    return this.prisma.user.findMany({
      select: { id: true, username: true, name: true, role: true, dataScope: true, status: true, phone: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    });
  }

  @Post()
  @Roles('OWNER')
  async create(@CurrentUser() user: AuthUser, @Body() dto: CreateUserDto): Promise<unknown> {
    const dataScope = dto.role === 'OWNER' || dto.role === 'CLERK' ? 'ALL' : dto.role === 'REP' ? 'OWN_CUSTOMERS' : 'SELF';
    const created = await this.prisma.user.create({
      data: { tenantId: user.tenantId, username: dto.username, passwordHash: bcrypt.hashSync(dto.password, 10), name: dto.name, role: dto.role, dataScope, phone: dto.phone },
      select: { id: true, username: true, name: true, role: true },
    });
    await this.audit.log({ user, action: 'USER_CREATE', entityType: 'User', entityId: created.id, after: created });
    return created;
  }

  /** B1 验收路径: 禁用账号 → token_version bump → 旧 token 下一请求 401 */
  @Post(':id/disable')
  @Roles('OWNER')
  async disable(@CurrentUser() user: AuthUser, @Param('id') id: string): Promise<unknown> {
    const target = await this.prisma.user.findUnique({ where: { id } });
    if (!target) throw new NotFoundException('用户不存在');
    if (target.id === user.id) throw new BadRequestException('不能禁用自己');
    await this.prisma.user.update({ where: { id }, data: { status: 'DISABLED' } });
    await this.auth.revokeTokens(id, 'disable');
    await this.audit.log({ user, action: AuditAction.USER_DISABLE, entityType: 'User', entityId: id, before: { status: target.status }, after: { status: 'DISABLED' } });
    return { ok: true };
  }
}

@Module({ controllers: [UsersController] })
export class UsersModule {}
