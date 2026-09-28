import { Controller, Get, Injectable, Module, Query } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { Roles } from '../../common/roles.guard';
import { CurrentUser } from '../../common/current-user.decorator';
import type { AuthUser } from '../../common/current-user.decorator';

// ═══════════════ P0-T50 客户商城商品浏览 ═══════════════
// 客户侧商品列表: 在售商品 + 解析后的可用价(专属价>终端供货>二批>一批>零售, D08/R1)
// 红线: 客户不可见成本价; 无生效价商品不返回(避免下单失败歧义)
@Controller('shop')
export class ShopController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('products')
  @Roles('CUSTOMER')
  async products(@CurrentUser() user: AuthUser, @Query('q') q?: string): Promise<unknown> {
    if (!user.customerId) return { items: [] };
    const now = new Date();
    const valid = { validFrom: { lte: now }, OR: [{ validTo: null }, { validTo: { gte: now } }] };
    const products = await this.prisma.product.findMany({
      where: { status: 'ON_SALE', name: q ? { contains: q } : undefined },
      select: {
        id: true, name: true, specText: true, baseUnit: true, minUnit: true, packSize: true,
        customerPrice: { where: { customerId: user.customerId, ...valid }, orderBy: { validFrom: 'desc' }, take: 1 },
        prices: { where: { ...valid, levelType: { in: ['TERMINAL', 'TIER2', 'TIER1', 'RETAIL'] } }, orderBy: [{ levelType: 'asc' }, { validFrom: 'desc' }] },
      },
      take: 100,
    });
    const levelOrder: Array<'TERMINAL' | 'TIER2' | 'TIER1' | 'RETAIL'> = ['TERMINAL', 'TIER2', 'TIER1', 'RETAIL'];
    const items = products.map((p) => {
      const exclusive = p.customerPrice[0];
      let price: Prisma.Decimal | undefined;
      let priceType = '';
      if (exclusive) {
        price = exclusive.price; priceType = 'CUSTOMER_EXCLUSIVE';
      } else {
        for (const lv of levelOrder) {
          const row = p.prices.find((x) => x.levelType === lv);
          if (row) { price = row.price; priceType = lv; break; }
        }
      }
      if (!price) return null; // 无生效价不展示(下单也会被拒)
      return { productId: p.id, name: p.name, specText: p.specText, baseUnit: p.baseUnit, minUnit: p.minUnit, packSize: p.packSize, price: Number(price), unit: exclusive?.unit ?? 'BASE', priceType };
    }).filter((x): x is NonNullable<typeof x> => x !== null);
    return { items };
  }
}

@Module({ controllers: [ShopController] })
export class ShopModule {}
