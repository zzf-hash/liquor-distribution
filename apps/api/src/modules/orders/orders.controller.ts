import { Body, Controller, Get, Headers, Ip, Param, Patch, Post, Query } from '@nestjs/common';
import { IsArray, IsBoolean, IsEnum, IsNumber, IsObject, IsOptional, IsString, Min, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { OrdersService, CreateOrderDto } from './orders.service';
import { Roles } from '../../common/roles.guard';
import { CurrentUser } from '../../common/current-user.decorator';
import type { AuthUser } from '../../common/current-user.decorator';

class LineDto {
  @IsString() productId!: string;
  @IsNumber() @Min(0.001) qty!: number;
  @IsEnum(['BASE', 'MIN']) unit!: 'BASE' | 'MIN';
  @IsOptional() @IsNumber() priceOverride?: number;
  @IsOptional() @IsBoolean() isGift?: boolean;
}

class CreateOrderBody implements CreateOrderDto {
  // P1-5: CUSTOMER 端不传(身份取 token), CLERK/REP 代下单必传 → 可选 + service 层按角色校验
  @IsOptional() @IsString() customerId?: string;
  @IsEnum(['CLERK', 'REP', 'CUSTOMER']) source!: 'CLERK' | 'REP' | 'CUSTOMER';
  @IsArray() @ValidateNested({ each: true }) @Type(() => LineDto) lines!: LineDto[];
  @IsOptional() @IsString() addressOverride?: string;
  @IsOptional() @IsString() deliveryDate?: string;
  @IsOptional() @IsString() note?: string;
  @IsOptional() @IsBoolean() forceSpecial?: boolean;
  @IsOptional() @IsString() specialReason?: string;
}

class ReasonDto {
  @IsString() reason!: string;
}

class ApproveSpecialDto {
  @IsEnum(['CREDIT_RELEASE', 'PRICE_SPECIAL', 'ORDER_SPECIAL']) type!: 'CREDIT_RELEASE' | 'PRICE_SPECIAL' | 'ORDER_SPECIAL';
  @IsString() reason!: string;
  @IsOptional() @IsNumber() amount?: number;
}

class SignDto {
  @IsEnum(['E_SIGN', 'PHOTO', 'PAPER']) type!: 'E_SIGN' | 'PHOTO' | 'PAPER';
  @IsOptional() @IsString() signerName?: string;
  @IsOptional() @IsString() photoUrl?: string;
  @IsOptional() @IsString() signatureData?: string;
  @IsOptional() @IsString() deviceInfo?: string;
  @IsOptional() @IsArray() returnPackages?: Array<{ category: string; qty: number }>;
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => SignLineDto) lines?: SignLineDto[];
}

class SignLineDto {
  @IsString() orderLineId!: string;
  @IsNumber() @Min(0) actualQty!: number;
}

class ReverseLineDto {
  @IsNumber() @Min(0.001) qty!: number;
  @IsString() reason!: string;
}

@Controller('orders')
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  /** P0-T20 三入口接单(内勤/业务员/客户), 统一进订单池 */
  @Post()
  @Roles('CLERK', 'OWNER', 'REP', 'CUSTOMER')
  async create(@Body() dto: CreateOrderBody, @CurrentUser() user: AuthUser, @Ip() ip: string): Promise<unknown> {
    return this.orders.create(dto, user, ip);
  }

  @Get()
  @Roles('OWNER', 'CLERK', 'REP', 'WAREHOUSE', 'CUSTOMER')
  async list(
    @CurrentUser() user: AuthUser,
    @Query('status') status?: string,
    @Query('customerId') customerId?: string,
    @Query('q') keyword?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ): Promise<unknown> {
    return this.orders.list(user, {
      status,
      customerId,
      keyword,
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined,
    });
  }

  @Get(':id')
  @Roles('OWNER', 'CLERK', 'REP', 'WAREHOUSE', 'CUSTOMER')
  async detail(@CurrentUser() user: AuthUser, @Param('id') id: string): Promise<unknown> {
    return this.orders.detail(user, id);
  }

  @Post(':id/confirm')
  @Roles('CLERK', 'OWNER')
  async confirm(@CurrentUser() user: AuthUser, @Param('id') id: string, @Ip() ip: string): Promise<unknown> {
    return this.orders.confirm(user, id, ip);
  }

  @Post(':id/approve-special')
  @Roles('OWNER')
  async approveSpecial(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: ApproveSpecialDto, @Ip() ip: string): Promise<unknown> {
    return this.orders.approveSpecial(user, id, dto, ip);
  }

  @Post(':id/cancel')
  @Roles('CLERK', 'OWNER', 'REP')
  async cancel(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: ReasonDto, @Ip() ip: string): Promise<unknown> {
    return this.orders.cancel(user, id, dto.reason, ip);
  }

  /** P0-T25 改单 = 红字冲销行(配送前) */
  @Post(':id/lines/:lineId/reverse')
  @Roles('CLERK', 'OWNER')
  async reverseLine(@CurrentUser() user: AuthUser, @Param('id') id: string, @Param('lineId') lineId: string, @Body() dto: ReverseLineDto, @Ip() ip: string): Promise<unknown> {
    return this.orders.reverseLine(user, id, lineId, dto.qty, dto.reason, ip);
  }

  /** P0-T22 出库: 生成 FIFO 拣货单 */
  @Post(':id/outbound')
  @Roles('WAREHOUSE', 'OWNER')
  async createOutbound(@CurrentUser() user: AuthUser, @Param('id') id: string): Promise<unknown> {
    return this.orders.createOutbound(user, id);
  }

  /** 出库单列表(仓配工作台) */
  @Get('outbounds')
  @Roles('WAREHOUSE', 'OWNER', 'CLERK')
  async listOutbounds(
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ): Promise<unknown> {
    return this.orders.listOutbounds({ status, page: page ? Number(page) : undefined, pageSize: pageSize ? Number(pageSize) : undefined });
  }

  /** P0-T22 复核确认出库(库存流水, 幂等) */
  @Post('outbounds/:outboundNo/confirm')
  @Roles('WAREHOUSE', 'OWNER')
  async confirmOutbound(
    @CurrentUser() user: AuthUser,
    @Param('outboundNo') outboundNo: string,
    @Headers('idempotency-key') idemKey: string,
    @Ip() ip: string,
  ): Promise<unknown> {
    return this.orders.confirmOutbound(user, outboundNo, idemKey, ip);
  }

  @Post(':id/deliver')
  @Roles('WAREHOUSE', 'OWNER')
  async deliver(@CurrentUser() user: AuthUser, @Param('id') id: string, @Ip() ip: string): Promise<unknown> {
    return this.orders.deliver(user, id, ip);
  }

  /** P0-T23 签收(网签/拍照) + P0-T24 纸单回录(type=PAPER, D+1 时限由内勤自律, 超期进异常待办) */
  @Post(':id/sign')
  @Roles('WAREHOUSE', 'CLERK', 'OWNER')
  async sign(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: SignDto, @Ip() ip: string): Promise<unknown> {
    return this.orders.sign(user, id, dto, ip);
  }

  @Post(':id/reject')
  @Roles('WAREHOUSE', 'CLERK', 'OWNER')
  async reject(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: ReasonDto, @Ip() ip: string): Promise<unknown> {
    return this.orders.reject(user, id, dto.reason, ip);
  }
}
