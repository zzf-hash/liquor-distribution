import { BadRequestException, Body, Controller, Get, Module, NotFoundException, Param, Post, Query } from '@nestjs/common';
import { IsEnum, IsInt, IsOptional, IsString, Min, MinLength } from 'class-validator';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../../audit/audit.service';
import { Roles } from '../../common/roles.guard';
import { CurrentUser } from '../../common/current-user.decorator';
import type { AuthUser } from '../../common/current-user.decorator';
import { requirePriceUnit } from '../../common/require-price-unit';

// ═══════════════ C组 随单赠规则引擎 (M3-1 买N送M) ═══════════════
// 规则商品级: 下单管线(OrdersService.create)对命中的行自动追加 0 价赠品行(promoNote 留痕),
// 赠品计入库存预检; 三入口(内勤/代下/客户商城)统一生效。
// GET  /promotions                生效中+已关闭列表(全员可读, 商城展示用)
// POST /promotions                新建(老板/内勤)
// POST /promotions/:id/close      关闭

class CreatePromotionDto {
  @IsString() productId!: string;
  @IsOptional() @IsString() giftProductId?: string;
  @IsInt() @Min(1) buyQty!: number;
  @IsInt() @Min(1) giftQty!: number;
  @IsOptional() @IsEnum(['BASE', 'MIN']) unit?: 'BASE' | 'MIN';
  @IsOptional() @IsString() validTo?: string;
  @IsOptional() @IsString() note?: string;
}

class ReasonDto {
  @IsString() @MinLength(1) reason!: string;
}

@Controller('promotions')
export class PromotionsController {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  @Get()
  @Roles('OWNER', 'CLERK', 'REP', 'WAREHOUSE', 'CUSTOMER')
  async list(@CurrentUser() user: AuthUser, @Query('active') active?: string): Promise<unknown> {
    const now = new Date();
    const where = active === '1'
      ? { tenantId: user.tenantId, closedAt: null, validFrom: { lte: now }, OR: [{ validTo: null }, { validTo: { gte: now } }] }
      : { tenantId: user.tenantId };
    const rows = await this.prisma.promotion.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: {
        product: { select: { skuCode: true, name: true, baseUnit: true, minUnit: true } },
        giftProduct: { select: { skuCode: true, name: true } },
      },
    });
    return rows.map((p) => ({
      id: p.id, kind: p.kind, productId: p.productId, productName: p.product.name, skuCode: p.product.skuCode,
      giftProductId: p.giftProductId, giftProductName: p.giftProduct?.name ?? p.product.name,
      buyQty: p.buyQty, giftQty: p.giftQty, unit: p.unit, unitLabel: p.unit === 'BASE' ? p.product.baseUnit : p.product.minUnit,
      validFrom: p.validFrom, validTo: p.validTo, closedAt: p.closedAt, note: p.note,
      active: !p.closedAt && p.validFrom <= now && (!p.validTo || p.validTo >= now),
    }));
  }

  @Post()
  @Roles('OWNER', 'CLERK')
  async create(@CurrentUser() user: AuthUser, @Body() dto: CreatePromotionDto): Promise<unknown> {
    const product = await this.prisma.product.findUnique({ where: { id: dto.productId } });
    if (!product) throw new NotFoundException('商品不存在');
    const gift = dto.giftProductId ? await this.prisma.product.findUnique({ where: { id: dto.giftProductId } }) : null;
    if (dto.giftProductId && !gift) throw new NotFoundException('赠品商品不存在');
    if (dto.buyQty < 1 || dto.giftQty < 1) throw new BadRequestException('买/送数量须 ≥ 1');
    const created = await this.prisma.promotion.create({
      data: {
        tenantId: user.tenantId, productId: dto.productId, giftProductId: dto.giftProductId ?? null,
        buyQty: dto.buyQty, giftQty: dto.giftQty, unit: requirePriceUnit(dto.unit ?? 'BASE'),
        validTo: dto.validTo ? new Date(dto.validTo) : null, note: dto.note, createdById: user.id,
      },
    });
    await this.audit.log({ user, action: 'PROMOTION_CREATE', entityType: 'Promotion', entityId: created.id, after: { product: product.name, buy: dto.buyQty, gift: dto.giftQty, giftProduct: gift?.name ?? product.name } });
    return created;
  }

  @Post(':id/close')
  @Roles('OWNER', 'CLERK')
  async close(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: ReasonDto): Promise<unknown> {
    const claimed = await this.prisma.promotion.updateMany({ where: { id, tenantId: user.tenantId, closedAt: null }, data: { closedAt: new Date(), note: dto.reason } });
    if (claimed.count === 0) throw new NotFoundException('规则不存在或已关闭');
    await this.audit.log({ user, action: 'PROMOTION_CLOSE', entityType: 'Promotion', entityId: id, after: { reason: dto.reason } });
    return { id, closed: true };
  }
}

/** 纯函数: 买N送M 赠品行计算(orders.service 共用; 规则数组已按商品分组) */
export interface PromoRule {
  productId: string;
  giftProductId: string | null;
  buyQty: number;
  giftQty: number;
  unit: 'BASE' | 'MIN';
}
export interface PromoBuyLine {
  productId: string;
  unit: 'BASE' | 'MIN';
  qty: number;
  isGift?: boolean;
}

/** 同商品多行合并计数; 只对非赠品行计数; 同商品多规则取最先命中 */
export function computeGiftLines(buys: PromoBuyLine[], rules: PromoRule[]): Array<{ rule: PromoRule; giftProductId: string; giftQty: number }> {
  const qtyByProduct = new Map<string, number>();
  for (const b of buys) {
    if (b.isGift) continue;
    const key = `${b.productId}|${b.unit}`;
    qtyByProduct.set(key, (qtyByProduct.get(key) ?? 0) + b.qty);
  }
  const out: Array<{ rule: PromoRule; giftProductId: string; giftQty: number }> = [];
  const seen = new Set<string>();
  for (const r of rules) {
    if (seen.has(r.productId)) continue;
    const qty = qtyByProduct.get(`${r.productId}|${r.unit}`);
    if (!qty || qty < r.buyQty) continue;
    const times = Math.floor(qty / r.buyQty);
    out.push({ rule: r, giftProductId: r.giftProductId ?? r.productId, giftQty: times * r.giftQty });
    seen.add(r.productId);
  }
  return out;
}

@Module({ controllers: [PromotionsController] })
export class PromotionsModule {}
