import { Controller, Injectable, Logger, Module, OnApplicationBootstrap, OnModuleDestroy, Post, Query } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { tenantContext } from '../../prisma/tenant-context';
import { Roles } from '../../common/roles.guard';
import { CurrentUser } from '../../common/current-user.decorator';
import type { AuthUser } from '../../common/current-user.decorator';
import { SYSTEM_USER } from '../stock-alert/stock-alert.controller';
import { StatementsModule } from '../statements/statements.controller';
import { DailyTasksService } from './daily-tasks.service';

// ═══════════════ 每日自动化任务: 手动触发端点 + 定时器 ═══════════════
// POST /daily-tasks/reminders/run            到期提醒+逾期摘要推送(演示可反复跑, 幂等)
// POST /daily-tasks/statements/run?period=   月结对账单生成+推送(默认上月; 已存在跳过)
// POST /daily-tasks/archive/run              已结满6个月自动归档
// 定时: 每日 08:10 Asia/Shanghai(=UTC 00:10) 跑提醒+归档; 每月 1 日追加跑上月对账单。

@Controller('daily-tasks')
@Roles('OWNER', 'CLERK')
export class DailyTasksController {
  constructor(private readonly svc: DailyTasksService) {}

  @Post('reminders/run')
  async runReminders(@CurrentUser() user: AuthUser): Promise<unknown> {
    return this.svc.runDueReminders(user);
  }

  @Post('statements/run')
  async runStatements(@CurrentUser() user: AuthUser, @Query('period') period?: string): Promise<unknown> {
    return this.svc.runMonthlyStatements(user, period);
  }

  @Post('archive/run')
  async runArchive(@CurrentUser() user: AuthUser): Promise<unknown> {
    return this.svc.runAutoArchive(user);
  }
}

// ═══════════════ 日切定时器(零依赖, 与 StockAlertDailyTask 同框架错峰 40 分钟) ═══════════════
@Injectable()
export class DailyTasksTimer implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('DailyTasksTimer');
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly prisma: PrismaService, private readonly svc: DailyTasksService) {}

  onApplicationBootstrap(): void {
    this.scheduleNext();
  }

  onModuleDestroy(): void {
    if (this.timer) clearTimeout(this.timer);
  }

  private scheduleNext(): void {
    const now = new Date();
    // 每日 08:10 Asia/Shanghai = UTC 00:10
    const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 10, 0));
    if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);
    const delay = Math.max(1000, next.getTime() - now.getTime());
    this.timer = setTimeout(() => {
      void this.safeRun();
      this.scheduleNext();
    }, delay);
    this.logger.log(`daily tasks scheduled at ${next.toISOString()} (in ${Math.round(delay / 3600000)}h)`);
  }

  /** 上海时区当日日期(仅用于"每月1日跑对账单"判断) */
  private shanghaiDay(): number {
    return new Date(Date.now() + 8 * 3600 * 1000).getUTCDate();
  }

  private async safeRun(): Promise<void> {
    const runMonthly = this.shanghaiDay() === 1;
    for (const tenant of await this.prisma.tenant.findMany({ select: { id: true, code: true } })) {
      const sys = SYSTEM_USER(tenant.id);
      try {
        await tenantContext.run({ tenantId: tenant.id }, async () => {
          const rem = await this.svc.runDueReminders(sys);
          const arch = await this.svc.runAutoArchive(sys);
          let stmt: unknown = null;
          if (runMonthly) stmt = await this.svc.runMonthlyStatements(sys);
          this.logger.log(`tenant ${tenant.code}: reminders=${rem.dueSoonCount} archived=${arch.archived}${runMonthly ? ` statements=${JSON.stringify(stmt)}` : ''}`);
        });
      } catch (e) {
        this.logger.error(`tenant ${tenant.code} daily tasks failed: ${String(e).slice(0, 300)}`);
      }
    }
  }
}

@Module({
  imports: [StatementsModule],
  controllers: [DailyTasksController],
  providers: [DailyTasksService, DailyTasksTimer],
  exports: [DailyTasksService],
})
export class DailyTasksModule {}
