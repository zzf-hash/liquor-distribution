import { Body, Controller, Get, Injectable, Module, Param, Post, Query, Res } from '@nestjs/common';
import { IsArray, IsEnum, IsOptional, IsString, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import type { Response } from 'express';
import { StatementsService } from './statements.service';
import { Roles } from '../../common/roles.guard';
import { CurrentUser } from '../../common/current-user.decorator';
import type { AuthUser } from '../../common/current-user.decorator';
import { buildXlsx, sendXlsx, exportFilename, ExportSheet } from '../../common/export.util';

class GenerateDto {
  @IsString() customerId!: string;
  @IsString() period!: string;
}

class DisputeItemDto {
  @IsEnum(['MISSING_ORDER', 'PRICE', 'GIFT', 'RETURN']) type!: 'MISSING_ORDER' | 'PRICE' | 'GIFT' | 'RETURN';
  @IsString() content!: string;
}

class DisputeDto {
  @IsArray() @ValidateNested({ each: true }) @Type(() => DisputeItemDto) items!: DisputeItemDto[];
}

class ResolveDto {
  @IsString() resolution!: string;
}

@Controller('statements')
@Roles('OWNER', 'CLERK', 'CUSTOMER')
export class StatementsController {
  constructor(private readonly svc: StatementsService) {}

  @Post('generate')
  @Roles('OWNER', 'CLERK')
  async generate(@CurrentUser() user: AuthUser, @Body() dto: GenerateDto): Promise<unknown> {
    return this.svc.generate(user, dto);
  }

  @Get()
  async list(@CurrentUser() user: AuthUser, @Query('status') status?: string, @Query('customerId') customerId?: string, @Query('period') period?: string): Promise<unknown> {
    return this.svc.list(user, { status, customerId, period });
  }

  /** M1-5 对账单导出(xlsx; 近 100 张) */
  @Get('export')
  @Roles('OWNER', 'CLERK')
  async export(@CurrentUser() user: AuthUser, @Query('status') status?: string, @Query('period') period?: string, @Res() res?: Response): Promise<void> {
    const STATUS_LABELS: Record<string, string> = { GENERATED: '已生成', SENT: '已推送', CONFIRMED: '客户已确认', DISPUTED: '有异议', RESOLVED: '异议已处理' };
    const rows = (await this.svc.list(user, { status, period })) as Array<Record<string, unknown>>;
    const sheet: ExportSheet<Record<string, unknown>> = {
      name: '对账单',
      columns: [
        { key: 'statementNo', header: '对账单号', width: 18 },
        { key: 'customer', header: '客户', width: 16, value: (r) => String((r.customer as { name?: string } | null)?.name ?? '') },
        { key: 'period', header: '账期', width: 10 },
        { key: 'totalCharged', header: '当期应收', width: 12, value: (r) => Number(r.totalCharged) },
        { key: 'totalSettled', header: '当期核销', width: 12, value: (r) => Number(r.totalSettled) },
        { key: 'openBalance', header: '期末未结', width: 12, value: (r) => Number(r.openBalance) },
        { key: 'status', header: '状态', width: 12, value: (r) => STATUS_LABELS[String(r.status)] ?? String(r.status) },
        { key: 'sentAt', header: '推送时间', width: 18, value: (r) => (r.sentAt ? String(r.sentAt).slice(0, 16).replace('T', ' ') : null) },
        { key: 'confirmedAt', header: '确认时间', width: 18, value: (r) => (r.confirmedAt ? String(r.confirmedAt).slice(0, 16).replace('T', ' ') : null) },
      ],
      rows,
      title: `月结对账单(共 ${rows.length} 张)`,
    };
    sendXlsx(res!, exportFilename('对账单'), buildXlsx([sheet]));
  }

  @Get(':id')
  async detail(@CurrentUser() user: AuthUser, @Param('id') id: string): Promise<unknown> {
    return this.svc.detail(user, id);
  }

  @Post(':id/send')
  @Roles('OWNER', 'CLERK')
  async send(@CurrentUser() user: AuthUser, @Param('id') id: string): Promise<unknown> {
    return this.svc.send(user, id);
  }

  /** 客户确认(客户 token; 内勤可代) */
  @Post(':id/confirm')
  async confirm(@CurrentUser() user: AuthUser, @Param('id') id: string): Promise<unknown> {
    return this.svc.confirm(user, id);
  }

  /** 客户异议: 差异四类进工作池 */
  @Post(':id/dispute')
  async dispute(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: DisputeDto): Promise<unknown> {
    return this.svc.dispute(user, id, dto.items);
  }

  @Post('disputes/:disputeId/resolve')
  @Roles('OWNER', 'CLERK')
  async resolveDispute(@CurrentUser() user: AuthUser, @Param('disputeId') disputeId: string, @Body() dto: ResolveDto): Promise<unknown> {
    return this.svc.resolveDispute(user, disputeId, dto.resolution);
  }
}

@Module({ controllers: [StatementsController], providers: [StatementsService], exports: [StatementsService] })
export class StatementsModule {}
