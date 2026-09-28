import { Body, Controller, ForbiddenException, Get, Injectable, Module, NotFoundException, Post, Query } from '@nestjs/common';
import { IsObject, IsOptional, IsString } from 'class-validator';
import dayjs from 'dayjs';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../../audit/audit.service';
import { Roles } from '../../common/roles.guard';
import { CurrentUser } from '../../common/current-user.decorator';
import type { AuthUser } from '../../common/current-user.decorator';

// ═══════════════ P1-T13 拜访管理 (八步骤 + 水印相机打卡 + ABC 频率; T09 绩效数据源) ═══════════════
// 打卡记录 append-only(不可篡改口径: 时间/定位/照片水印); 业务员只看自己

class CreateVisitDto {
  @IsString() customerId!: string;
  @IsOptional() @IsString() location?: string;
  @IsOptional() @IsString() photoUrl?: string;
  @IsOptional() @IsObject() steps?: Record<string, boolean>;
  @IsOptional() @IsString() notes?: string;
}

@Controller('visits')
@Roles('OWNER', 'CLERK', 'REP')
export class VisitsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  @Post()
  @Roles('REP', 'OWNER')
  async create(@CurrentUser() user: AuthUser, @Body() dto: CreateVisitDto): Promise<unknown> {
    const customer = await this.prisma.customer.findUnique({ where: { id: dto.customerId } });
    if (!customer) throw new NotFoundException('客户不存在');
    if (user.role === 'REP' && customer.salespersonId !== user.id) {
      throw new ForbiddenException('仅可拜访自己的客户');
    }
    const created = await this.prisma.visit.create({
      data: {
        tenantId: user.tenantId, repId: user.id, customerId: dto.customerId,
        location: dto.location, photoUrl: dto.photoUrl, steps: (dto.steps ?? undefined) as never,
        notes: dto.notes, abcLevel: customer.abcLevel,
      },
    });
    await this.audit.log({ user, action: 'VISIT_CREATE', entityType: 'Visit', entityId: created.id, after: { customer: customer.name, location: dto.location } });
    return created;
  }

  @Get()
  async list(@CurrentUser() user: AuthUser, @Query('mine') mine?: string, @Query('month') month?: string, @Query('customerId') customerId?: string): Promise<unknown> {
    const monthStart = month ? dayjs(`${month}-01`).startOf('month').toDate() : dayjs().startOf('month').toDate();
    const monthEnd = month ? dayjs(`${month}-01`).endOf('month').toDate() : dayjs().endOf('month').toDate();
    return this.prisma.visit.findMany({
      where: {
        repId: mine || user.role === 'REP' ? user.id : undefined,
        customerId,
        visitedAt: { gte: monthStart, lte: monthEnd },
      },
      orderBy: { visitedAt: 'desc' },
      take: 200,
      include: { customer: { select: { code: true, name: true, abcLevel: true } } },
    });
  }

  @Get('stats')
  async stats(@CurrentUser() user: AuthUser, @Query('month') month?: string): Promise<unknown> {
    const m = month ?? dayjs().format('YYYY-MM');
    const start = dayjs(`${m}-01`).startOf('month').toDate();
    const end = dayjs(`${m}-01`).endOf('month').toDate();
    const where = { visitedAt: { gte: start, lte: end } };
    if (user.role === 'REP') Object.assign(where, { repId: user.id });
    const grouped = await this.prisma.visit.groupBy({ by: ['repId'], where, _count: { id: true } });
    const repIds = grouped.map((g) => g.repId);
    const reps = repIds.length ? await this.prisma.user.findMany({ where: { id: { in: repIds } }, select: { id: true, name: true } }) : [];
    return {
      month: m,
      count: grouped.reduce((s, g) => s + g._count.id, 0),
      byRep: grouped.map((g) => ({ repId: g.repId, name: reps.find((r) => r.id === g.repId)?.name ?? '未知', count: g._count.id })),
    };
  }
}

@Module({ controllers: [VisitsController] })
export class VisitsModule {}
