import { Body, Controller, Get, Injectable, Module, Param, Post, Query } from '@nestjs/common';
import { IsArray, IsBoolean, IsEnum, IsNumber, IsOptional, IsString, Min, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { SpecialOrdersService } from './special-orders.service';
import { ApprovalsModule } from '../approvals/approvals.controller';
import { OrdersModule } from '../orders/orders.module';
import { Roles } from '../../common/roles.guard';
import { CurrentUser } from '../../common/current-user.decorator';
import type { AuthUser } from '../../common/current-user.decorator';

class SpecialLineDto {
  @IsOptional() @IsString() productId?: string;
  @IsString() productName!: string;
  @IsOptional() @IsString() specText?: string;
  @IsString() unit!: string;
  @IsNumber() @Min(0.001) qty!: number;
  @IsNumber() @Min(0) price!: number;
  @IsOptional() @IsString() note?: string;
}

class CreateSpecialDto {
  @IsString() title!: string;
  @IsOptional() @IsString() customerId?: string;
  @IsString() customerName!: string;
  @IsOptional() @IsBoolean() isBanquet?: boolean;
  @IsOptional() @IsString() eventDate?: string;
  @IsOptional() @IsString() venue?: string;
  @IsString() contactName!: string;
  @IsString() contactPhone!: string;
  @IsString() address!: string;
  @IsOptional() @IsString() deliveryDate?: string;
  @IsOptional() @IsString() payeeName?: string;
  @IsOptional() @IsString() payDueDate?: string;
  @IsOptional() @IsString() note?: string;
  @IsArray() @ValidateNested({ each: true }) @Type(() => SpecialLineDto) lines!: SpecialLineDto[];
}

class SubmitDto {
  @IsString() reason!: string;
}

@Controller('special-orders')
@Roles('OWNER', 'CLERK', 'REP', 'WAREHOUSE') // F8 全员下单
export class SpecialOrdersController {
  constructor(private readonly svc: SpecialOrdersService) {}

  @Post()
  async create(@CurrentUser() user: AuthUser, @Body() dto: CreateSpecialDto): Promise<unknown> {
    return this.svc.create(user, dto);
  }

  @Get()
  async list(
    @CurrentUser() user: AuthUser,
    @Query('status') status?: string,
    @Query('q') keyword?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ): Promise<unknown> {
    return this.svc.list(user, { status, keyword, page: page ? Number(page) : undefined, pageSize: pageSize ? Number(pageSize) : undefined });
  }

  @Get(':id')
  async detail(@CurrentUser() user: AuthUser, @Param('id') id: string): Promise<unknown> {
    return this.svc.detail(user, id);
  }

  @Post(':id/submit')
  async submit(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: SubmitDto): Promise<unknown> {
    return this.svc.submit(user, id, dto.reason);
  }

  @Post(':id/convert')
  @Roles('OWNER', 'CLERK') // 转正式订单=内勤动作
  async convert(@CurrentUser() user: AuthUser, @Param('id') id: string): Promise<unknown> {
    return this.svc.convert(user, id);
  }
}

@Module({
  imports: [ApprovalsModule, OrdersModule],
  controllers: [SpecialOrdersController],
  providers: [SpecialOrdersService],
})
export class SpecialOrdersModule {}
