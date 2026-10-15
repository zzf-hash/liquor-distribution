import { Controller, Get, Injectable, Module, Query } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Roles } from '../common/roles.guard';
import { CurrentUser } from '../common/current-user.decorator';
import type { AuthUser } from '../common/current-user.decorator';

// P0-T03 审计查询: 按人/时间/单据/动作追溯(仅老板/内勤)
@Controller('audit')
@Roles('OWNER', 'CLERK')
export class AuditController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async list(
    @CurrentUser() user: AuthUser,
    @Query('action') action?: string,
    @Query('entityId') entityId?: string,
    @Query('userId') userId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ): Promise<unknown> {
    const p = Math.max(1, Math.floor(Number(page ?? 1)) || 1);
    const size = Math.min(200, Math.floor(Number(pageSize ?? 50)) || 50);
    const where = {
      action,
      entityId,
      userId,
      createdAt: {
        gte: from ? new Date(from) : undefined,
        lte: to ? new Date(`${to.slice(0, 10)}T23:59:59`) : undefined,
      },
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.auditLog.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (p - 1) * size, take: size }),
      this.prisma.auditLog.count({ where }),
    ]);
    void user;
    return { items, total };
  }
}

@Module({ controllers: [AuditController] })
export class AuditModule {}
