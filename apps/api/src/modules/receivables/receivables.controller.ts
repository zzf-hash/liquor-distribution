import { Body, Controller, Get, Headers, Ip, Param, Post, Query, Res } from '@nestjs/common';
import { IsNumber, IsOptional, IsString, Max, Min } from 'class-validator';
import type { Response } from 'express';
import { ReceivablesService, AgingBucket } from './receivables.service';
import { agingBucketLabels } from './aging';
import { Roles } from '../../common/roles.guard';
import { CurrentUser } from '../../common/current-user.decorator';
import type { AuthUser } from '../../common/current-user.decorator';
import { buildXlsx, sendXlsx, exportFilename, ExportSheet } from '../../common/export.util';

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

class WaiveDto {
  @IsNumber() @Min(0.01) amount!: number;
  @IsString() reason!: string;
}

/** M9-3 账龄档位(天): 三档上限, 1 ≤ b1 < b2 < b3 ≤ 365 */
class AgingConfigDto {
  @IsNumber() @Min(1) @Max(365) b1!: number;
  @IsNumber() @Min(1) @Max(365) b2!: number;
  @IsNumber() @Min(1) @Max(365) b3!: number;
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

  /** M9-3 账龄档位配置(默认 30/50/90, Q1 已确认); 档位文案一并下发供三端渲染 */
  @Get('receivables/aging-config')
  @Roles('OWNER', 'CLERK', 'REP', 'CUSTOMER')
  async agingConfig(@CurrentUser() user: AuthUser): Promise<unknown> {
    const config = await this.svc.getAgingConfig(user);
    return { config, labels: agingBucketLabels(config) };
  }

  @Post('receivables/aging-config')
  @Roles('OWNER')
  async saveAgingConfig(@CurrentUser() user: AuthUser, @Body() dto: AgingConfigDto, @Ip() ip: string): Promise<unknown> {
    return this.svc.saveAgingConfig(user, dto, ip);
  }

  /** M1-5 应收台账导出(xlsx; bucket 过滤与列表一致, 全量不分页) */
  @Get('receivables/export')
  @Roles('OWNER', 'CLERK', 'REP')
  async export(
    @CurrentUser() user: AuthUser,
    @Query('bucket') bucket?: AgingBucket,
    @Query('customerId') customerId?: string,
    @Res() res?: Response,
  ): Promise<void> {
    const page = await this.svc.list(user, { bucket, customerId, page: 1, pageSize: 200, archived: 'all' });
    const labels = agingBucketLabels(await this.svc.getAgingConfig(user));
    const sheet: ExportSheet<{ sourceDocNo: string; customerName: string; total: number; settled: number; open: number; dueDate: string; daysOverdue: number; bucket: string; disputeFlag: boolean }> = {
      name: '应收台账',
      columns: [
        { key: 'sourceDocNo', header: '单据号', width: 16 },
        { key: 'customerName', header: '客户', width: 16 },
        { key: 'total', header: '应收金额', width: 12, value: (r) => Number(r.total.toFixed(2)) },
        { key: 'settled', header: '已收', width: 12, value: (r) => Number(r.settled.toFixed(2)) },
        { key: 'open', header: '未收', width: 12, value: (r) => Number(r.open.toFixed(2)) },
        { key: 'dueDate', header: '到期日', width: 12 },
        { key: 'daysOverdue', header: '逾期天数', width: 10 },
        { key: 'bucket', header: '账龄档', width: 14, value: (r) => labels[r.bucket as keyof typeof labels] ?? r.bucket },
        { key: 'disputeFlag', header: '争议', width: 8 },
      ],
      rows: page.items,
      title: `应收台账(未结合计 ¥${page.openTotal.toFixed(2)})`,
    };
    sendXlsx(res!, exportFilename('应收台账'), buildXlsx([sheet]));
  }

  /** T51: 账期提醒(到期前N天, N可配) */
  @Get('receivables/reminders')
  @Roles('OWNER', 'CLERK', 'REP', 'CUSTOMER')
  async reminders(@CurrentUser() user: AuthUser): Promise<unknown> {
    return this.svc.reminders(user);
  }

  /** T03: 抹零发起(内勤; 单笔/月累计上限护栏) */
  @Post('receivables/:id/waive')
  @Roles('CLERK', 'OWNER')
  async waive(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: WaiveDto,
    @Headers('idempotency-key') idemKey: string,
    @Ip() ip: string,
  ): Promise<unknown> {
    return this.svc.waive(user, id, dto, idemKey, ip);
  }

  /** T03: 坏账核销(老板直接执行) */
  @Post('receivables/:id/write-off')
  @Roles('OWNER')
  async writeOff(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: ReasonDto,
    @Headers('idempotency-key') idemKey: string,
    @Ip() ip: string,
  ): Promise<unknown> {
    return this.svc.writeOff(user, id, dto.reason, idemKey, ip);
  }

  /** T32: 已结满6个月软归档(客户不可见, 后台可恢复) */
  @Post('receivables/:id/archive')
  @Roles('OWNER', 'CLERK')
  async archive(@CurrentUser() user: AuthUser, @Param('id') id: string, @Ip() ip: string): Promise<unknown> {
    return this.svc.archive(user, id, ip);
  }

  @Post('receivables/:id/unarchive')
  @Roles('OWNER')
  async unarchive(@CurrentUser() user: AuthUser, @Param('id') id: string, @Ip() ip: string): Promise<unknown> {
    return this.svc.unarchive(user, id, ip);
  }

  @Get('payments')
  @Roles('OWNER', 'CLERK', 'REP', 'CUSTOMER')
  async payments(@CurrentUser() user: AuthUser, @Query('status') status?: string, @Query('customerId') customerId?: string): Promise<unknown> {
    return this.svc.payments(user, { status, customerId });
  }

  /** M1-5 收款单导出(xlsx; 过滤与列表一致, 近 100 笔) */
  @Get('payments/export')
  @Roles('OWNER', 'CLERK')
  async paymentsExport(@CurrentUser() user: AuthUser, @Query('status') status?: string, @Res() res?: Response): Promise<void> {
    const KIND_LABELS: Record<string, string> = { PAYMENT: '收款', WAIVE: '抹零', BAD_DEBT: '坏账核销' };
    const STATUS_LABELS: Record<string, string> = { REPORTED: '待确认', CONFIRMED: '已销账', CANCELLED: '已冲正' };
    const rows = (await this.svc.payments(user, { status })) as Array<Record<string, unknown>>;
    const sheet: ExportSheet<Record<string, unknown>> = {
      name: '收款单',
      columns: [
        { key: 'paymentNo', header: '收款单号', width: 18 },
        { key: 'customer', header: '客户', width: 16, value: (r) => String((r.customer as { name?: string } | null)?.name ?? '') },
        { key: 'amount', header: '金额', width: 12, value: (r) => Number(r.amount) },
        { key: 'kind', header: '类型', width: 10, value: (r) => KIND_LABELS[String(r.kind)] ?? String(r.kind) },
        { key: 'method', header: '方式', width: 10 },
        { key: 'voucher', header: '凭证', width: 16 },
        { key: 'status', header: '状态', width: 10, value: (r) => STATUS_LABELS[String(r.status)] ?? String(r.status) },
        { key: 'confirmedAt', header: '销账时间', width: 18, value: (r) => (r.confirmedAt ? String(r.confirmedAt).slice(0, 16).replace('T', ' ') : null) },
        { key: 'createdAt', header: '登记时间', width: 18, value: (r) => String(r.createdAt).slice(0, 16).replace('T', ' ') },
        { key: 'note', header: '备注', width: 24 },
      ],
      rows,
      title: `收款单(共 ${rows.length} 笔)`,
    };
    sendXlsx(res!, exportFilename('收款单'), buildXlsx([sheet]));
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
