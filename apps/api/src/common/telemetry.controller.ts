import { Body, Controller, Get, Module, Post, Query } from '@nestjs/common';
import { Roles } from './roles.guard';
import { Type } from 'class-transformer';
import { IsArray, IsIn, IsInt, IsObject, IsOptional, IsString, MaxLength, ValidateNested } from 'class-validator';
import { PrismaService } from '../prisma/prisma.service';
import { TelemetryInterceptor } from './telemetry.interceptor';
import { TelemetryService } from './telemetry.service';

/** 三端前端错误/事件上报。免鉴权但限流式收敛: 数组批≤20条, 字段强截断, 垃圾数据直接 400。 */
class TelemetryEventDto {
  @IsIn(['miniapp', 'admin']) source!: 'miniapp' | 'admin';
  @IsIn(['error', 'custom']) kind!: 'error' | 'custom';
  @IsString() @MaxLength(300) name!: string;
  @IsOptional() @IsIn(['info', 'warn', 'error']) level?: 'info' | 'warn' | 'error';
  @IsOptional() @IsString() @MaxLength(300) path?: string;
  @IsOptional() @IsInt() status?: number;
  @IsOptional() @IsInt() durationMs?: number;
  @IsOptional() @IsString() @MaxLength(120) userId?: string;
  @IsOptional() @IsString() @MaxLength(60) role?: string;
  @IsOptional() @IsObject() detail?: Record<string, unknown>;
}
class TelemetryBatchDto {
  @IsArray() @ValidateNested({ each: true }) @Type(() => TelemetryEventDto)
  events!: TelemetryEventDto[];
}

@Controller('telemetry')
export class TelemetryController {
  constructor(private readonly telemetry: TelemetryService, private readonly prisma: PrismaService) {}

  @Post('events')
  async batch(@Body() dto: TelemetryBatchDto): Promise<{ accepted: number }> {
    const events = (dto.events ?? []).slice(0, 20);
    for (const ev of events) this.telemetry.record({ ...ev, source: ev.source });
    return { accepted: events.length };
  }

  /** 运维速览: 最近错误/慢请求计数(admin 用) — P1: 跨租户计数收紧为内勤/老板(原任意已认证用户含 CUSTOMER 可读) */
  @Get('summary')
  @Roles('OWNER', 'CLERK')
  async summary(@Query('hours') hours?: string): Promise<unknown> {
    const h = Math.min(168, Math.max(1, Number(hours) || 24));
    const since = new Date(Date.now() - h * 3600_000);
    const [errors, slow, warns, byStatus] = await Promise.all([
      this.prisma.telemetryEvent.count({ where: { level: 'error', createdAt: { gte: since } } }),
      this.prisma.telemetryEvent.count({ where: { durationMs: { gt: 1000 }, createdAt: { gte: since } } }),
      this.prisma.telemetryEvent.count({ where: { level: 'warn', createdAt: { gte: since } } }),
      this.prisma.telemetryEvent.groupBy({
        by: ['status'],
        where: { createdAt: { gte: since }, status: { gte: 400 } },
        _count: true,
      }),
    ]);
    return { windowHours: h, errors, warns, slowRequests: slow, clientErrorsByStatus: byStatus };
  }
}

@Module({ providers: [TelemetryService, TelemetryInterceptor], controllers: [TelemetryController], exports: [TelemetryService] })
export class TelemetryModule {}
