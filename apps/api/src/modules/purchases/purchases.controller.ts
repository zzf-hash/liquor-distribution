import { Body, Controller, Get, Headers, Injectable, Module, Param, Post, Query } from '@nestjs/common';
import { IsArray, IsEnum, IsNumber, IsOptional, IsString, Min, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { PurchasesService } from './purchases.service';
import { ApprovalsModule } from '../approvals/approvals.controller';
import { Roles } from '../../common/roles.guard';
import { CurrentUser } from '../../common/current-user.decorator';
import type { AuthUser } from '../../common/current-user.decorator';

class PurchaseLineDto {
  @IsString() productId!: string;
  @IsString() batchNo!: string;
  @IsNumber() @Min(0.001) qty!: number;
  @IsNumber() @Min(0) unitCost!: number;
  @IsOptional() @IsString() produceDate?: string;
  @IsOptional() @IsString() expiryDate?: string;
}

class CreatePurchaseDto {
  @IsString() supplier!: string;
  @IsEnum(['PREPAID', 'POSTPAID']) type!: 'PREPAID' | 'POSTPAID';
  @IsOptional() @IsString() payeeNote?: string;
  @IsOptional() @IsString() note?: string;
  @IsArray() @ValidateNested({ each: true }) @Type(() => PurchaseLineDto) lines!: PurchaseLineDto[];
}

class PayDto {
  @IsOptional() @IsString() note?: string;
}

@Controller('purchases')
@Roles('OWNER', 'CLERK', 'WAREHOUSE')
export class PurchasesController {
  constructor(private readonly svc: PurchasesService) {}

  @Post()
  @Roles('OWNER', 'CLERK')
  async create(@CurrentUser() user: AuthUser, @Body() dto: CreatePurchaseDto): Promise<unknown> {
    return this.svc.create(user, dto);
  }

  @Get()
  async list(@Query('status') status?: string, @Query('page') page?: string, @Query('pageSize') pageSize?: string): Promise<unknown> {
    return this.svc.list({ status, page: page ? Number(page) : undefined, pageSize: pageSize ? Number(pageSize) : undefined });
  }

  @Get(':id')
  async detail(@Param('id') id: string): Promise<unknown> {
    return this.svc.detail(id);
  }

  @Post(':id/submit')
  @Roles('OWNER', 'CLERK')
  async submit(@CurrentUser() user: AuthUser, @Param('id') id: string): Promise<unknown> {
    return this.svc.submit(user, id);
  }

  /** F3 先付: APPROVED→PAID; F4 后付: RECEIVED→PAID (资金动作, 幂等) */
  @Post(':id/pay')
  @Roles('OWNER', 'CLERK')
  async pay(@CurrentUser() user: AuthUser, @Param('id') id: string, @Headers('idempotency-key') idemKey: string, @Body() dto: PayDto): Promise<unknown> {
    return this.svc.pay(user, id, idemKey, dto.note);
  }

  /** 收货入库: F3=PAID 后, F4=APPROVED 后; 批次+IN 流水+COST 价版本 */
  @Post(':id/receive')
  @Roles('WAREHOUSE', 'OWNER')
  async receive(@CurrentUser() user: AuthUser, @Param('id') id: string): Promise<unknown> {
    return this.svc.receive(user, id);
  }
}

@Module({ imports: [ApprovalsModule], controllers: [PurchasesController], providers: [PurchasesService], exports: [PurchasesService] })
export class PurchasesModule {}
