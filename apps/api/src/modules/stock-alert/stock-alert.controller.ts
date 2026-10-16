import { Body, Controller, Get, Injectable, Logger, Module, OnModuleDestroy, OnModuleInit, Param, Post, Query } from '@nestjs/common';
import { IsBoolean, IsEnum, IsNumber, IsObject, IsOptional, IsString, Max, Min, MinLength } from 'class-validator';
import { PrismaService } from '../../prisma/prisma.service';
import { tenantContext } from '../../prisma/tenant-context';
import { Roles } from '../../common/roles.guard';
import { CurrentUser } from '../../common/current-user.decorator';
import type { AuthUser } from '../../common/current-user.decorator';
import { StockAlertService } from './stock-alert.service';
import { TelemetryService } from '../../common/telemetry.service';
import { TelemetryModule } from '../../common/telemetry.controller';
import { ApprovalsModule } from '../approvals/approvals.controller';
import { PurchasesModule } from '../purchases/purchases.controller';
import type { AlertConfig } from './stock-alert.service';

// ═══════════════ P2 库存预警 + 自动报货 ═══════════════
// /stock-alert/config        GET/PUT 配置(老板): 窗口/安全天数/覆盖天数/开关/商品级覆盖
// /stock-alert/run           POST 手动扫描(老板/内勤, 默认不建报货单; ?create=1 建)
// /stock-alert/report        GET 每日库存报表(老板/内勤, 当日无快照惰性补)
// /stock-alert/restocks      GET 报货单列表(老板/内勤)
// /stock-alert/restocks/:id/confirm  POST 内勤确认→转采购单+提审(老板审)
// /stock-alert/restocks/:id/dismiss  POST 内勤忽略

/** 系统任务身份(日切 cron 无登录态): id=system, 审计 username=SYSTEM role=SYSTEM */
export function SYSTEM_USER(tenantId: string): AuthUser {
  return { id: 'system', tenantId, username: 'system', name: '系统', role: 'OWNER', dataScope: 'ALL', aud: 'staff' };
}

@Injectable()
export class SystemConfigReader {
  constructor(private readonly prisma: PrismaService) {}
  async tenantIds(): Promise<string[]> {
    return (await this.prisma.tenant.findMany({ select: { id: true } })).map((t) => t.id);
  }
}

class SaveConfigDto {
  @IsOptional() @IsNumber() @Min(1) @Max(90) windowDays?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(90) safetyDays?: number;
  @IsOptional() @IsNumber() @Min(1) @Max(90) coverageDays?: number;
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional() @IsString() defaultSupplier?: string;
  @IsOptional() @IsObject() perProduct?: Record<string, { windowDays?: number; enabled?: boolean }>;
}

class ConfirmDto {
  @IsOptional() @IsNumber() qty?: number;
  @IsOptional() @IsString() supplier?: string;
  @IsOptional() @IsEnum(['PREPAID', 'POSTPAID']) type?: 'PREPAID' | 'POSTPAID';
  @IsOptional() @IsString() note?: string;
}

class DismissDto {
  @IsString() @MinLength(1) reason!: string;
}

/** M2-3 临期预警配置 */
class SaveExpiryConfigDto {
  @IsOptional() @IsNumber() @Min(1) @Max(365) warnDays?: number;
  @IsOptional() @IsBoolean() enabled?: boolean;
}

@Controller('stock-alert')
export class StockAlertController {
  constructor(private readonly svc: StockAlertService, private readonly cfgReader: SystemConfigReader) {}

  @Get('config')
  @Roles('OWNER', 'CLERK')
  async getConfig(@CurrentUser() user: AuthUser): Promise<unknown> {
    return this.svc.getConfig(user.tenantId);
  }

  @Post('config')
  @Roles('OWNER')
  async saveConfig(@CurrentUser() user: AuthUser, @Body() dto: SaveConfigDto): Promise<unknown> {
    return this.svc.saveConfig(user, dto);
  }

  @Post('run')
  @Roles('OWNER', 'CLERK')
  async run(@CurrentUser() user: AuthUser, @Query('create') create?: string): Promise<unknown> {
    return this.svc.runScan(user, { createRestocks: create === '1' || create === 'true' });
  }

  // ─────────────── M2-3/M7-4 临期预警: 效期维度扫描(与数量预警互补) ───────────────

  @Get('expiry')
  @Roles('OWNER', 'CLERK')
  async expiry(@CurrentUser() user: AuthUser): Promise<unknown> {
    return this.svc.listExpiry(user);
  }

  @Get('expiry/config')
  @Roles('OWNER', 'CLERK')
  async expiryConfig(@CurrentUser() user: AuthUser): Promise<unknown> {
    return this.svc.getExpiryConfig(user.tenantId);
  }

  @Post('expiry/config')
  @Roles('OWNER')
  async saveExpiryConfig(@CurrentUser() user: AuthUser, @Body() dto: SaveExpiryConfigDto): Promise<unknown> {
    return this.svc.saveExpiryConfig(user, dto);
  }

  @Get('report')
  @Roles('OWNER', 'CLERK')
  async report(
    @CurrentUser() user: AuthUser,
    @Query('date') date?: string,
    @Query('level') level?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ): Promise<unknown> {
    return this.svc.listReport(user, { date, level, page: page ? Number(page) : undefined, pageSize: pageSize ? Number(pageSize) : undefined });
  }

  @Get('restocks')
  @Roles('OWNER', 'CLERK')
  async restocks(
    @CurrentUser() user: AuthUser,
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ): Promise<unknown> {
    return this.svc.listRestocks(user, { status, page: page ? Number(page) : undefined, pageSize: pageSize ? Number(pageSize) : undefined });
  }

  @Post('restocks/:id/confirm')
  @Roles('OWNER', 'CLERK')
  async confirm(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: ConfirmDto): Promise<unknown> {
    return this.svc.confirm(user, id, dto);
  }

  @Post('restocks/:id/dismiss')
  @Roles('OWNER', 'CLERK')
  async dismiss(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: DismissDto): Promise<unknown> {
    return this.svc.dismiss(user, id, dto.reason);
  }
}

// ═══════════════ 日切任务: 每日 07:30(Asia/Shanghai) 全租户 扫描+建报货单+推摘要 ═══════════════
// 零依赖实现(不引 @nestjs/schedule): onModuleInit 起定时器, 对齐下一个 07:30 触发, 每 24h 重复。
// API 容器单实例部署(compose 无 scale), 无并发重复风险; 手动补跑用 POST /stock-alert/run。

@Injectable()
export class StockAlertDailyTask implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('StockAlertDaily');
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly svc: StockAlertService, private readonly cfgReader: SystemConfigReader, private readonly telemetry: TelemetryService) {}

  onModuleInit(): void {
    this.scheduleNext();
  }

  onModuleDestroy(): void {
    if (this.timer) clearTimeout(this.timer);
  }

  private scheduleNext(): void {
    const now = new Date();
    // 下一个 07:30 Asia/Shanghai = UTC 23:30(前一日)
    const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 23, 30, 0));
    if (now.getUTCHours() >= 23 && now.getUTCMinutes() >= 30) next.setUTCDate(next.getUTCDate() + 1);
    // 夏令时不存在的时区直接数学对齐; 存在的(上海无)无影响
    const delay = Math.max(1000, next.getTime() - now.getTime());
    this.timer = setTimeout(() => {
      void this.safeRun();
      this.scheduleNext(); // 触发后排下一天
    }, delay);
    this.logger.log(`daily stock scan scheduled at ${next.toISOString()} (in ${Math.round(delay / 3600000)}h)`);
  }

  private async safeRun(): Promise<void> {
    try {
      const results = await this.runAllTenants();
      this.logger.log(`daily stock scan done: ${JSON.stringify(results)}`);
    } catch (e) {
      this.logger.error(`daily stock scan failed: ${String(e).slice(0, 300)}`);
    }
    // 遥测保留期清理(30天): 借每日定时器顺带执行, 失败不影响主任务
    try {
      const pruned = await this.telemetry.prune();
      if (pruned > 0) this.logger.log(`telemetry pruned ${pruned} rows`);
    } catch { /* 遥测清理失败静默 */ }
  }

  async runAllTenants(): Promise<Array<{ tenantId: string; reportDate: string; rows: number; alerts: number; created: number } | { tenantId: string; error: string }>> {
    const out: Array<{ tenantId: string; reportDate: string; rows: number; alerts: number; created: number } | { tenantId: string; error: string }> = [];
    for (const tenantId of await this.cfgReader.tenantIds()) {
      try {
        // 逐租户切换注入层上下文(2026-10 审查修复配套: 租户注入以请求 store 为准,
        // 系统任务遍历多租户时必须 run 对应租户, 否则扫描/自动提审被收敛到调用者租户)
        await tenantContext.run({ tenantId }, async () => {
          out.push({ tenantId, ...(await this.svc.runScan(SYSTEM_USER(tenantId), { createRestocks: true })) });
        });
      } catch (e) {
        out.push({ tenantId, error: String(e).slice(0, 300) });
      }
    }
    return out;
  }
}

@Module({
  imports: [ApprovalsModule, PurchasesModule, TelemetryModule], // ApprovalsService(提审) + PurchasesService(转采购单) + TelemetryService(保留期清理)
  controllers: [StockAlertController],
  providers: [StockAlertService, SystemConfigReader, StockAlertDailyTask],
  exports: [StockAlertService, StockAlertDailyTask],
})
export class StockAlertModule {}
