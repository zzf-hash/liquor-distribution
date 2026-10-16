import { Body, Controller, Get, Injectable, Module, Param, Post, Query } from '@nestjs/common';
import { IsArray, IsBoolean, IsEnum, IsNumber, IsOptional, IsString, Min, MinLength, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { CapFeesService } from './cap-fees.service';
import { ExpensesModule } from '../expenses/expenses.controller';
import { Roles } from '../../common/roles.guard';
import { CurrentUser } from '../../common/current-user.decorator';
import type { AuthUser } from '../../common/current-user.decorator';

// ═══════════════ B组 开瓶费 API ═══════════════
// GET  /cap-fees/policies                       政策列表(全员可读, 小程序提交回收需要)
// POST /cap-fees/policies                       新建/更新政策(老板/内勤)
// POST /cap-fees/policies/:id/close             关闭政策
// POST /cap-fees/recycles                       登记瓶盖回收(业务员/仓配/内勤)
// GET  /cap-fees/recycles?status=               回收单列表(业务员只见自己)
// POST /cap-fees/recycles/:id/confirm           出纳确认→生成 CAP_FEE 费用单(进审批)
// POST /cap-fees/recycles/:id/cancel            取消(待确认)
// POST /cap-fees/accrue?period=YYYY-MM          不回瓶盖月度自动计提(默认上月; 幂等)

class PolicyDto {
  @IsString() productId!: string;
  @IsNumber() @Min(0.0001) perBottleFee!: number;
  @IsOptional() @IsBoolean() requireCap?: boolean;
  @IsOptional() @IsNumber() @Min(0.0001) noCapRate?: number;
}

class RecycleLineDto {
  @IsString() productId!: string;
  @IsNumber() @Min(1) qty!: number;
}

class RecycleDto {
  @IsString() customerId!: string;
  @IsArray() @ValidateNested({ each: true }) @Type(() => RecycleLineDto) lines!: RecycleLineDto[];
  @IsOptional() @IsString() note?: string;
}

class ConfirmDto {
  @IsOptional() @IsEnum(['CASH', 'AR_OFFSET']) payMode?: 'CASH' | 'AR_OFFSET';
  @IsOptional() @IsString() note?: string;
}

class ReasonDto {
  @IsString() @MinLength(1) reason!: string;
}

@Controller('cap-fees')
export class CapFeesController {
  constructor(private readonly svc: CapFeesService) {}

  @Get('policies')
  @Roles('OWNER', 'CLERK', 'REP', 'WAREHOUSE')
  async policies(@CurrentUser() user: AuthUser): Promise<unknown> {
    return this.svc.listPolicies(user);
  }

  @Post('policies')
  @Roles('OWNER', 'CLERK')
  async savePolicy(@CurrentUser() user: AuthUser, @Body() dto: PolicyDto): Promise<unknown> {
    return this.svc.savePolicy(user, dto);
  }

  @Post('policies/:id/close')
  @Roles('OWNER', 'CLERK')
  async closePolicy(@CurrentUser() user: AuthUser, @Param('id') id: string): Promise<unknown> {
    return this.svc.closePolicy(user, id);
  }

  @Post('recycles')
  @Roles('OWNER', 'CLERK', 'REP', 'WAREHOUSE')
  async createRecycle(@CurrentUser() user: AuthUser, @Body() dto: RecycleDto): Promise<unknown> {
    return this.svc.createRecycle(user, dto);
  }

  @Get('recycles')
  @Roles('OWNER', 'CLERK', 'REP', 'WAREHOUSE')
  async recycles(
    @CurrentUser() user: AuthUser,
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ): Promise<unknown> {
    return this.svc.listRecycles(user, { status, page: page ? Number(page) : undefined, pageSize: pageSize ? Number(pageSize) : undefined });
  }

  @Post('recycles/:id/confirm')
  @Roles('OWNER', 'CLERK')
  async confirm(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: ConfirmDto): Promise<unknown> {
    return this.svc.confirmRecycle(user, id, dto);
  }

  @Post('recycles/:id/cancel')
  @Roles('OWNER', 'CLERK', 'REP', 'WAREHOUSE')
  async cancel(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: ReasonDto): Promise<unknown> {
    return this.svc.cancelRecycle(user, id, dto.reason);
  }

  @Post('accrue')
  @Roles('OWNER', 'CLERK')
  async accrue(@CurrentUser() user: AuthUser, @Query('period') period?: string): Promise<unknown> {
    return this.svc.accrue(user, period);
  }
}

@Module({ imports: [ExpensesModule], controllers: [CapFeesController], providers: [CapFeesService], exports: [CapFeesService] })
export class CapFeesModule {}
