import { Body, Controller, Get, Headers, Ip, Param, Post, Query } from '@nestjs/common';
import { IsNumber, IsOptional, IsString, Min } from 'class-validator';
import { ReceivablesService, AgingBucket } from './receivables.service';
import { Roles } from '../../common/roles.guard';
import { CurrentUser } from '../../common/current-user.decorator';
import type { AuthUser } from '../../common/current-user.decorator';

class ReportPaymentDto {
  @IsString() customerId!: string;
  @IsNumber() @Min(0.01) amount!: number;
  @IsOptional() @IsString() method?: string;
  @IsOptional() @IsString() voucher?: string;
  @IsOptional() @IsString() note?: string;
}

class ReasonDto {
  @IsString() reason!: string;
}

@Controller()
export class ReceivablesController {
  constructor(private readonly svc: ReceivablesService) {}

  /** P0-T30 应收台账(账龄分档, 争议款单列) */
  @Get('receivables')
  @Roles('OWNER', 'CLERK', 'REP', 'CUSTOMER')
  async list(
    @CurrentUser() user: AuthUser,
    @Query('bucket') bucket?: AgingBucket,
    @Query('customerId') customerId?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ): Promise<unknown> {
    return this.svc.list(user, { bucket, customerId, page: page ? Number(page) : undefined, pageSize: pageSize ? Number(pageSize) : undefined });
  }

  @Get('receivables/summary')
  @Roles('OWNER', 'CLERK')
  async summary(@CurrentUser() user: AuthUser): Promise<unknown> {
    return this.svc.summary(user);
  }

  @Get('payments')
  @Roles('OWNER', 'CLERK', 'REP', 'CUSTOMER')
  async payments(@CurrentUser() user: AuthUser, @Query('status') status?: string, @Query('customerId') customerId?: string): Promise<unknown> {
    return this.svc.payments(user, { status, customerId });
  }

  /** P0-T31 F9①: 业务员上报(待内勤确认) / 内勤直录(即确认并销账); 幂等 */
  @Post('payments')
  @Roles('REP', 'CLERK', 'OWNER')
  async report(
    @CurrentUser() user: AuthUser,
    @Body() dto: ReportPaymentDto,
    @Headers('idempotency-key') idemKey: string,
    @Ip() ip: string,
  ): Promise<unknown> {
    return this.svc.reportPayment(user, dto, idemKey, ip);
  }

  /** P0-T31 F9②: 内勤确认 → FIFO 销账 + 清账通知(P0 站内=订单状态推送) */
  @Post('payments/:id/confirm')
  @Roles('CLERK', 'OWNER')
  async confirm(@CurrentUser() user: AuthUser, @Param('id') id: string, @Ip() ip: string): Promise<unknown> {
    return this.svc.confirmPayment(user, id, ip);
  }

  /** 收款冲正(红字, 仅老板) */
  @Post('payments/:id/reverse')
  @Roles('OWNER')
  async reverse(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: ReasonDto, @Ip() ip: string): Promise<unknown> {
    return this.svc.reversePayment(user, id, dto.reason, ip);
  }
}
