import { Body, Controller, Get, Injectable, Module, Param, Post, Query } from '@nestjs/common';
import { IsArray, IsBoolean, IsEnum, IsNumber, IsOptional, IsString, Min, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { PriceChangesService } from './price-changes.service';
import { ApprovalsModule } from '../approvals/approvals.controller';
import { Roles } from '../../common/roles.guard';
import { CurrentUser } from '../../common/current-user.decorator';
import type { AuthUser } from '../../common/current-user.decorator';

class CreatePriceChangeDto {
  @IsString() productId!: string;
  @IsEnum(['BASE', 'MIN']) unit!: 'BASE' | 'MIN';
  @IsEnum(['COST', 'TIER1', 'TIER2', 'TERMINAL', 'RETAIL']) levelType!: 'COST' | 'TIER1' | 'TIER2' | 'TERMINAL' | 'RETAIL';
  @IsNumber() @Min(0.01) newPrice!: number;
  @IsString() effectiveDate!: string;
  @IsString() reason!: string;
  @IsOptional() @IsBoolean() customerSync?: boolean;
}

/** C组 M2-7 一键批量调价 */
class BatchItemDto {
  @IsString() productId!: string;
  @IsOptional() @IsEnum(['BASE', 'MIN']) unit?: 'BASE' | 'MIN';
  @IsEnum(['COST', 'TIER1', 'TIER2', 'TERMINAL', 'RETAIL']) levelType!: 'COST' | 'TIER1' | 'TIER2' | 'TERMINAL' | 'RETAIL';
  @IsNumber() @Min(0.01) newPrice!: number;
}

class CreateBatchDto {
  @IsArray() @ValidateNested({ each: true }) @Type(() => BatchItemDto) items!: BatchItemDto[];
  @IsString() effectiveDate!: string;
  @IsString() reason!: string;
  @IsOptional() @IsBoolean() customerSync?: boolean;
}

@Controller('price-changes')
@Roles('OWNER', 'CLERK')
export class PriceChangesController {
  constructor(private readonly svc: PriceChangesService) {}

  @Post()
  async create(@CurrentUser() user: AuthUser, @Body() dto: CreatePriceChangeDto): Promise<unknown> {
    return this.svc.create(user, dto);
  }

  /** C组: 批量创建并逐单提审(共用批次号) */
  @Post('batch')
  async createBatch(@CurrentUser() user: AuthUser, @Body() dto: CreateBatchDto): Promise<unknown> {
    return this.svc.createBatch(user, dto);
  }

  /** C组: 批次列表(一键调价工作台) */
  @Get('batch')
  async batches(): Promise<unknown> {
    return this.svc.batches();
  }

  /** C组: 批量生效(该批次全部已批单) — 声明在 :batchNo 路由前防截留 */
  @Post('batch/:batchNo/effectuate')
  async effectuateBatch(@CurrentUser() user: AuthUser, @Param('batchNo') batchNo: string): Promise<unknown> {
    return this.svc.effectuateBatch(user, batchNo);
  }

  @Get()
  async list(@Query('status') status?: string, @Query('page') page?: string, @Query('pageSize') pageSize?: string): Promise<unknown> {
    return this.svc.list({ status, page: page ? Number(page) : undefined, pageSize: pageSize ? Number(pageSize) : undefined });
  }

  @Post(':id/submit')
  async submit(@CurrentUser() user: AuthUser, @Param('id') id: string): Promise<unknown> {
    return this.svc.submit(user, id);
  }

  /** 一键生效(新价格版本行) */
  @Post(':id/effectuate')
  async effectuate(@CurrentUser() user: AuthUser, @Param('id') id: string): Promise<unknown> {
    return this.svc.effectuate(user, id);
  }
}

@Module({ imports: [ApprovalsModule], controllers: [PriceChangesController], providers: [PriceChangesService] })
export class PriceChangesModule {}
