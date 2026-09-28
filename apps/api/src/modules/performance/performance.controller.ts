import { Body, Controller, Get, Injectable, Module, Param, Post, Query } from '@nestjs/common';
import { IsString } from 'class-validator';
import { PerformanceService } from './performance.service';
import { Roles } from '../../common/roles.guard';
import { CurrentUser } from '../../common/current-user.decorator';
import type { AuthUser } from '../../common/current-user.decorator';

class MonthDto {
  @IsString() month!: string;
}

@Controller()
@Roles('OWNER', 'CLERK')
export class PerformanceController {
  constructor(private readonly svc: PerformanceService) {}

  @Get('performance')
  async monthly(@CurrentUser() user: AuthUser, @Query('month') month: string): Promise<unknown> {
    return this.svc.monthly(user, month);
  }

  @Post('payroll/generate')
  async generate(@CurrentUser() user: AuthUser, @Body() dto: MonthDto): Promise<unknown> {
    return this.svc.generatePayroll(user, dto.month);
  }

  @Get('payroll')
  async payroll(@CurrentUser() user: AuthUser, @Query('month') month: string): Promise<unknown> {
    return this.svc.payroll(user, month);
  }

  @Post('payroll/:id/confirm')
  @Roles('OWNER')
  async confirm(@CurrentUser() user: AuthUser, @Param('id') id: string): Promise<unknown> {
    return this.svc.confirmPayroll(user, id);
  }
}

@Module({ controllers: [PerformanceController], providers: [PerformanceService] })
export class PerformanceModule {}
