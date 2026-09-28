import { Body, Controller, Get, Injectable, Module, Param, Post, Query } from '@nestjs/common';
import { IsArray, IsEnum, IsNumber, IsOptional, IsString, Min, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { StocktakesService } from './stocktakes.service';
import { ApprovalsModule } from '../approvals/approvals.controller';
import { Roles } from '../../common/roles.guard';
import { CurrentUser } from '../../common/current-user.decorator';
import type { AuthUser } from '../../common/current-user.decorator';

class CreateStocktakeDto {
  @IsEnum(['SPOT', 'FULL']) type!: 'SPOT' | 'FULL';
  @IsOptional() @IsString() category?: string;
}

class CountLineDto {
  @IsString() id!: string;
  @IsNumber() @Min(0) countedQty!: number;
}

class CountDto {
  @IsArray() @ValidateNested({ each: true }) @Type(() => CountLineDto) lines!: CountLineDto[];
}

@Controller('stocktakes')
@Roles('OWNER', 'CLERK', 'WAREHOUSE')
export class StocktakesController {
  constructor(private readonly svc: StocktakesService) {}

  @Post()
  @Roles('WAREHOUSE', 'OWNER')
  async create(@CurrentUser() user: AuthUser, @Body() dto: CreateStocktakeDto): Promise<unknown> {
    return this.svc.create(user, dto);
  }

  @Post(':id/count')
  @Roles('WAREHOUSE', 'OWNER')
  async count(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: CountDto): Promise<unknown> {
    return this.svc.count(user, id, dto.lines);
  }

  @Post(':id/reconcile')
  @Roles('CLERK', 'OWNER')
  async reconcile(@CurrentUser() user: AuthUser, @Param('id') id: string): Promise<unknown> {
    return this.svc.reconcile(user, id);
  }

  @Post(':id/adjust')
  @Roles('CLERK', 'OWNER')
  async adjust(@CurrentUser() user: AuthUser, @Param('id') id: string): Promise<unknown> {
    return this.svc.adjust(user, id);
  }

  @Get()
  async list(@Query('status') status?: string, @Query('page') page?: string, @Query('pageSize') pageSize?: string): Promise<unknown> {
    return this.svc.list({ status, page: page ? Number(page) : undefined, pageSize: pageSize ? Number(pageSize) : undefined });
  }

  @Get(':id')
  async detail(@Param('id') id: string): Promise<unknown> {
    return this.svc.detail(id);
  }
}

@Module({ imports: [ApprovalsModule], controllers: [StocktakesController], providers: [StocktakesService] })
export class StocktakesModule {}
