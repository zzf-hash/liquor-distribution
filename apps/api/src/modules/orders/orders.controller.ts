import { Body, Controller, Get, Headers, Ip, Param, Patch, Post, Query, Res } from '@nestjs/common';
import { IsArray, IsBoolean, IsEnum, IsNumber, IsObject, IsOptional, IsString, Min, registerDecorator, ValidateNested, ValidationArguments, ValidationOptions } from 'class-validator';
import { Type } from 'class-transformer';
import type { Response } from 'express';
import dayjs from 'dayjs';
import { OrdersService, CreateOrderDto } from './orders.service';
import { ORDER_STATUS_LABELS } from '../../statemachine/order-state';
import { Roles } from '../../common/roles.guard';
import { CurrentUser } from '../../common/current-user.decorator';
import type { AuthUser } from '../../common/current-user.decorator';
import { buildXlsx, sendXlsx, exportFilename, ExportSheet } from '../../common/export.util';
import { signProofMessage, type SignProofInput } from './sign-proof';

/** 挂在 type 上，校验整张签收单：电子签要签名，纸单和拍照要照片。 */
function SignProofPresent(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string): void {
    registerDecorator({
      name: 'signProofPresent',
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate(_value: unknown, args: ValidationArguments): boolean {
          return signProofMessage(args.object as SignProofInput) === null;
        },
        defaultMessage(args: ValidationArguments): string {
          return signProofMessage(args.object as SignProofInput) ?? '签收凭证缺失';
        },
      },
    });
  };
}

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

export class SignDto {
  @IsEnum(['E_SIGN', 'PHOTO', 'PAPER'])
  @SignProofPresent()
  type!: 'E_SIGN' | 'PHOTO' | 'PAPER';
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

  /** P0-T20 三入口接单(内勤/业务员/客户), 统一进订单池; Idempotency-Key 幂等(重试不重复下单) */
  @Post()
  @Roles('CLERK', 'OWNER', 'REP', 'CUSTOMER')
  async create(@Body() dto: CreateOrderBody, @CurrentUser() user: AuthUser, @Headers('idempotency-key') idemKey: string, @Ip() ip: string): Promise<unknown> {
    return this.orders.create(dto, user, idemKey, ip);
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

  /** 出库单列表(仓配工作台) — 必须声明在 @Get(':id') 之前, 否则被 :id='outbounds' 截走 */
  @Get('outbounds')
  @Roles('WAREHOUSE', 'OWNER', 'CLERK')
  async listOutbounds(
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ): Promise<unknown> {
    return this.orders.listOutbounds({ status, page: page ? Number(page) : undefined, pageSize: pageSize ? Number(pageSize) : undefined });
  }

  /** M1-5 订单导出(xlsx; 过滤条件与列表一致, 分页拉全量, 上限 2000 行) */
  @Get('export')
  @Roles('OWNER', 'CLERK')
  async export(
    @CurrentUser() user: AuthUser,
    @Query('status') status?: string,
    @Query('customerId') customerId?: string,
    @Query('q') keyword?: string,
    @Res() res?: Response,
  ): Promise<void> {
    const rows: Array<Record<string, unknown>> = [];
    for (let page = 1; page <= 20; page++) {
      const batch = await this.orders.list(user, { status, customerId, keyword, page, pageSize: 100 });
      rows.push(...(batch.items as Array<Record<string, unknown>>));
      if (rows.length >= batch.total) break;
    }
    const sheet: ExportSheet<Record<string, unknown>> = {
      name: '订单',
      columns: [
        { key: 'orderNo', header: '订单号', width: 18 },
        { key: 'status', header: '状态', width: 10, value: (r) => ORDER_STATUS_LABELS[r.status as keyof typeof ORDER_STATUS_LABELS] ?? String(r.status ?? '') },
        { key: 'customerName', header: '客户', width: 16 },
        { key: 'totalAmount', header: '订单金额', width: 12, value: (r) => Number(r.totalAmount) },
        { key: 'source', header: '来源', width: 10 },
        { key: 'lineCount', header: '行数', width: 8 },
        { key: 'specialApproved', header: '特批', width: 8 },
        { key: 'createdAt', header: '创建时间', width: 18, value: (r) => dayjs(r.createdAt as string).format('YYYY-MM-DD HH:mm') },
        { key: 'deliveryDate', header: '配送日期', width: 12, value: (r) => (r.deliveryDate ? dayjs(r.deliveryDate as string).format('YYYY-MM-DD') : null) },
        { key: 'addressSnapshot', header: '配送地址', width: 28 },
      ],
      rows,
      title: `订单清单(共 ${rows.length} 单)`,
    };
    sendXlsx(res!, exportFilename('订单'), buildXlsx([sheet]));
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

  /** P0-T22 出库: 生成 FIFO 拣货单 — CLERK 可发起(内勤页"生成拣货单"按钮原 403) */
  @Post(':id/outbound')
  @Roles('WAREHOUSE', 'OWNER', 'CLERK')
  async createOutbound(@CurrentUser() user: AuthUser, @Param('id') id: string): Promise<unknown> {
    return this.orders.createOutbound(user, id);
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
