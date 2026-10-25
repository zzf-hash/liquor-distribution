import { Body, Controller, Get, Injectable, Ip, Module, Param, Post, Query } from '@nestjs/common';
import { IsEnum, IsNumber, IsOptional, IsString, Min, MinLength } from 'class-validator';
import { ExpensesService } from './expenses.service';
import { ApprovalsModule } from '../approvals/approvals.controller';
import { Roles } from '../../common/roles.guard';
import { CurrentUser } from '../../common/current-user.decorator';
import type { AuthUser } from '../../common/current-user.decorator';

// ═══════════════ B组 费用域 API ═══════════════
// POST /expenses                    创建(进 EXPENSE 审批线; 内勤/老板)
// GET  /expenses                    台账列表(科目/状态/客户/月份过滤)
// GET  /expenses/summary?month=     按科目汇总(M10-3 台账)
// GET  /expenses/:id                详情
// POST /expenses/:id/pay            付款(CASH)或冲抵货款(AR_OFFSET→FEE_OFFSET FIFO)
// POST /expenses/:id/cancel         取消(仅待审批)

const CATEGORIES = ['OFFICE', 'FUEL_TOLL', 'REPAIR', 'HANDLING', 'UTILITY', 'DISPLAY', 'ENTRY', 'OTHER'] as const;

class CreateExpenseDto {
  @IsEnum(CATEGORIES) category!: (typeof CATEGORIES)[number];
  @IsString() @MinLength(1) title!: string;
  @IsNumber() @Min(0.01) amount!: number;
  @IsOptional() @IsString() customerId?: string;
  @IsOptional() @IsString() payee?: string;
  @IsOptional() @IsString() occurredAt?: string;
  @IsOptional() @IsEnum(['CASH', 'AR_OFFSET']) payMode?: 'CASH' | 'AR_OFFSET';
  @IsOptional() @IsString() note?: string;
  @IsOptional() @IsString() voucherUrl?: string;
}

class PayDto {
  @IsOptional() @IsString() voucherUrl?: string;
  @IsOptional() @IsString() note?: string;
}

class ReasonDto {
  @IsString() @MinLength(1) reason!: string;
}

@Controller('expenses')
@Roles('OWNER', 'CLERK')
export class ExpensesController {
  constructor(private readonly svc: ExpensesService) {}

  @Post()
  async create(@CurrentUser() user: AuthUser, @Body() dto: CreateExpenseDto): Promise<unknown> {
    return this.svc.create(user, dto);
  }

  @Get('summary')
  async summary(@CurrentUser() user: AuthUser, @Query('month') month?: string): Promise<unknown> {
    return this.svc.summary(user, month);
  }

  @Get()
  async list(
    @CurrentUser() user: AuthUser,
    @Query('category') category?: string,
    @Query('status') status?: string,
    @Query('customerId') customerId?: string,
    @Query('month') month?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ): Promise<unknown> {
    return this.svc.list(user, { category, status, customerId, month, page: page ? Number(page) : undefined, pageSize: pageSize ? Number(pageSize) : undefined });
  }

  @Get(':id')
  async detail(@CurrentUser() user: AuthUser, @Param('id') id: string): Promise<unknown> {
    return this.svc.detail(user, id);
  }

  @Post(':id/pay')
  async pay(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: PayDto, @Ip() ip: string): Promise<unknown> {
    return this.svc.pay(user, id, dto, ip);
  }

  @Post(':id/cancel')
  async cancel(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: ReasonDto, @Ip() ip: string): Promise<unknown> {
    return this.svc.cancel(user, id, dto.reason, ip);
  }
}

@Module({ imports: [ApprovalsModule], controllers: [ExpensesController], providers: [ExpensesService], exports: [ExpensesService] })
export class ExpensesModule {}
