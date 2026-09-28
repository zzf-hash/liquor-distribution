import { Body, Controller, Get, Headers, Injectable, Module, Post, Query } from '@nestjs/common';
import { IsEnum, IsInt, IsOptional, IsString, Min } from 'class-validator';
import { PackagesService } from './packages.service';
import { Roles } from '../../common/roles.guard';
import { CurrentUser } from '../../common/current-user.decorator';
import type { AuthUser } from '../../common/current-user.decorator';

class CreatePackageDto {
  @IsString() customerId!: string;
  @IsString() category!: string;
  @IsInt() @Min(1) qty!: number;
  @IsEnum(['STANDALONE', 'OUT']) type!: 'STANDALONE' | 'OUT'; // WITH_ORDER 由签收内部生成
  @IsOptional() @IsString() note?: string;
}

@Controller('packages')
@Roles('OWNER', 'CLERK', 'WAREHOUSE')
export class PackagesController {
  constructor(private readonly svc: PackagesService) {}

  @Get('summary')
  async summary(): Promise<unknown> {
    return this.svc.summary();
  }

  @Get()
  async list(
    @Query('customerId') customerId?: string,
    @Query('category') category?: string,
    @Query('type') type?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ): Promise<unknown> {
    return this.svc.list({ customerId, category, type, page: page ? Number(page) : undefined, pageSize: pageSize ? Number(pageSize) : undefined });
  }

  /** F11 无单回收 / 押金退付 */
  @Post()
  async create(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreatePackageDto,
    @Headers('idempotency-key') idemKey: string,
  ): Promise<unknown> {
    return this.svc.create(user, { ...dto, type: dto.type as 'STANDALONE' | 'OUT' }, idemKey || undefined);
  }
}

@Module({ controllers: [PackagesController], providers: [PackagesService], exports: [PackagesService] })
export class PackagesModule {}
