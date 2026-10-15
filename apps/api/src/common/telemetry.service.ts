import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * TelemetryService: 轻量内建遥测(零外部依赖)。
 * - 记请求耗时/状态、三端前端错误、自定义事件 → TelemetryEvent 表
 * - 写失败绝不影响主流程(fire-and-forget + 静默吞错, 遥测本身不能成为故障源)
 * - 保留 30 天, prune() 由每日任务顺带调用
 */
const RETAIN_DAYS = 30;

@Injectable()
export class TelemetryService {
  private readonly logger = new Logger('Telemetry');
  constructor(private readonly prisma: PrismaService) {}

  record(ev: {
    source: 'api' | 'miniapp' | 'admin';
    kind: 'request' | 'error' | 'custom';
    name: string;
    level?: 'info' | 'warn' | 'error';
    path?: string;
    method?: string;
    status?: number;
    durationMs?: number;
    userId?: string;
    role?: string;
    detail?: unknown;
  }): void {
    // B1(全项目bug清查): name 缺失/非字符串时不再抛 TypeError 穿透——遥测自身必须静默不成为故障源
    const name = typeof ev.name === 'string' && ev.name ? ev.name : 'invalid_name';
    // 异步落库, 不 await; 遥测故障静默(最多打一行内部日志)
    this.prisma.telemetryEvent
      .create({
        data: {
          source: ev.source,
          kind: ev.kind,
          name: name.slice(0, 300),
          level: ev.level ?? 'info',
          path: ev.path?.slice(0, 300),
          method: ev.method,
          status: ev.status,
          durationMs: ev.durationMs,
          userId: ev.userId,
          role: ev.role,
          detail: (ev.detail ?? undefined) as never,
        },
      })
      .catch((e: unknown) => this.logger.warn(`telemetry write failed: ${e instanceof Error ? e.message : String(e)}`));
  }

  /** 保留期清理, 每日任务调用 */
  async prune(): Promise<number> {
    const cut = new Date(Date.now() - RETAIN_DAYS * 86400_000);
    const res = await this.prisma.telemetryEvent.deleteMany({ where: { createdAt: { lt: cut } } });
    return res.count;
  }
}
