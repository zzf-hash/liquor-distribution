import { Body, Controller, Get, Injectable, Module, Param, Post, Query } from '@nestjs/common';
import { IsEnum, IsNumber, IsOptional, IsString } from 'class-validator';
import { RebatesService } from './rebates.service';
import { Roles } from '../../common/roles.guard';
import { CurrentUser } from '../../common/current-user.decorator';
import type { AuthUser } from '../../common/current-user.decorator';

class CreateSchemeDto {
  @IsString() customerId!: string;
  @IsEnum(['B', 'C']) type!: 'B' | 'C';
  @IsNumber() rate!: number;
  @IsOptional() @IsString() note?: string;
  @IsOptional() @IsString() validTo?: string;
}

class SettleDto {
  @IsString() customerId!: string;
  @IsString() period!: string;
  @IsEnum(['GOODS', 'INVOICE']) settleType!: 'GOODS' | 'INVOICE';
  @IsOptional() @IsString() note?: string;
}

@Controller('rebates')
@Roles('OWNER', 'CLERK')
export class RebatesController {
  constructor(private readonly svc: RebatesService) {}

  @Get('schemes')
  async schemes(@Query('customerId') customerId?: string): Promise<unknown> {
    return this.svc.schemes({ customerId });
  }

  @Post('schemes')
  async createScheme(@CurrentUser() user: AuthUser, @Body() dto: CreateSchemeDto): Promise<unknown> {
    return this.svc.createScheme(user, dto);
  }

  @Post('schemes/:id/close')
  async closeScheme(@CurrentUser() user: AuthUser, @Param('id') id: string): Promise<unknown> {
    return this.svc.closeScheme(user, id);
  }

  @Post('settlements/preview')
  async preview(@CurrentUser() user: AuthUser, @Body() dto: { customerId: string; period: string }): Promise<unknown> {
    return this.svc.preview(user, dto.customerId, dto.period);
  }

  @Post('settlements')
  async settle(@CurrentUser() user: AuthUser, @Body() dto: SettleDto): Promise<unknown> {
    return this.svc.settle(user, dto);
  }

  @Get('settlements')
  async settlements(@Query('period') period?: string, @Query('customerId') customerId?: string): Promise<unknown> {
    return this.svc.settlements({ period, customerId });
  }
}

@Module({ controllers: [RebatesController], providers: [RebatesService] })
export class RebatesModule {}
