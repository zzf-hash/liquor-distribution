import { Body, Controller, Get, Injectable, Module, Param, Post, Query } from '@nestjs/common';
import { IsBoolean, IsEnum, IsNumber, IsOptional, IsString, Min } from 'class-validator';
import { PriceChangesService } from './price-changes.service';
import { ApprovalsModule } from '../approvals/approvals.controller';
import { Roles } from '../../common/roles.guard';
import { CurrentUser } from '../../common/current-user.decorator';
import type { AuthUser } from '../../common/current-user.decorator';

class CreatePriceChangeDto {
  @IsString() productId!: string;
  @IsEnum(['BASE', 'MIN']) unit!: 'BASE' | 'MIN';
  @IsEnum(['COST', 'TIER1', 'TIER2', 'TERMINAL', 'RETAIL']) levelType!: 'COST' | 'TIER1' | 'TIER2' | 'TERMINAL' | 'RETAIL';
  @IsNumber() @Min(0) newPrice!: number;
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
