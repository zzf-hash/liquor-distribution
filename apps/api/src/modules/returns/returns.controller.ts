import { Body, Controller, Get, Injectable, Module, Param, Post, Query } from '@nestjs/common';
import { IsArray, IsNumber, IsOptional, IsString, Min, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { ReturnsService } from './returns.service';
import { ApprovalsModule } from '../approvals/approvals.controller';
import { Roles } from '../../common/roles.guard';
import { CurrentUser } from '../../common/current-user.decorator';
import type { AuthUser } from '../../common/current-user.decorator';

class ReturnLineDto {
  @IsString() orderLineId!: string;
  @IsNumber() @Min(0.001) qty!: number;
  @IsOptional() @IsString() note?: string;
}

class CreateReturnDto {
  @IsString() sourceOrderId!: string;
  @IsString() reason!: string;
  @IsArray() @ValidateNested({ each: true }) @Type(() => ReturnLineDto) lines!: ReturnLineDto[];
}

class AppendLinesDto {
  @IsArray() @ValidateNested({ each: true }) @Type(() => ReturnLineDto) lines!: ReturnLineDto[];
}

@Controller('returns')
@Roles('OWNER', 'CLERK', 'WAREHOUSE')
export class ReturnsController {
  constructor(private readonly svc: ReturnsService) {}

  @Post()
  @Roles('OWNER', 'CLERK')
  async create(@CurrentUser() user: AuthUser, @Body() dto: CreateReturnDto): Promise<unknown> {
    return this.svc.create(user, dto);
  }

  @Get()
  async list(@CurrentUser() user: AuthUser, @Query('status') status?: string, @Query('page') page?: string, @Query('pageSize') pageSize?: string): Promise<unknown> {
    return this.svc.list(user, { status, page: page ? Number(page) : undefined, pageSize: pageSize ? Number(pageSize) : undefined });
  }

  @Get(':id')
  async detail(@Param('id') id: string): Promise<unknown> {
    return this.svc.detail(id);
  }

  /** R4: 数量只增——追加行 */
  @Post(':id/lines')
  @Roles('OWNER', 'CLERK')
  async appendLines(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: AppendLinesDto): Promise<unknown> {
    return this.svc.appendLines(user, id, dto.lines);
  }

  /** 收货回冲(仓库, APPROVED 后) */
  @Post(':id/receive')
  @Roles('WAREHOUSE', 'OWNER')
  async receive(@CurrentUser() user: AuthUser, @Param('id') id: string): Promise<unknown> {
    return this.svc.receive(user, id);
  }

  @Post(':id/cancel')
  @Roles('OWNER', 'CLERK')
  async cancel(@CurrentUser() user: AuthUser, @Param('id') id: string): Promise<unknown> {
    return this.svc.cancel(user, id);
  }
}

@Module({ imports: [ApprovalsModule], controllers: [ReturnsController], providers: [ReturnsService] })
export class ReturnsModule {}
