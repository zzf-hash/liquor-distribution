// P0-T10 商品档案：列表（含各级现价概要）/ 建档 / 详情 / 改档（审计）/ 停售（审计）
import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, PriceLevelType, PriceUnit, Product, ProductStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditAction, AuditService } from '../../audit/audit.service';
import type { AuthUser } from '../../common/current-user.decorator';
import { CreateProductDto, ListProductsDto, UpdateProductDto } from './dto';

/** 概要：同一 (计价单位×价格级别) 只取当前生效的最新版本 */
export interface PriceSummaryItem {
  unit: PriceUnit;
  levelType: PriceLevelType;
  price: Prisma.Decimal;
  validFrom: Date;
}

export type ProductWithSummary = Product & { priceSummary: PriceSummaryItem[] };

@Injectable()
export class ProductsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(
    user: AuthUser,
    query: ListProductsDto,
  ): Promise<{ items: ProductWithSummary[]; total: number }> {
    const where: Prisma.ProductWhereInput = { tenantId: user.tenantId };
    const q = query.q?.trim();
    if (q) {
      where.OR = [
        { name: { contains: q, mode: 'insensitive' } },
        { pinyinFirst: { startsWith: q, mode: 'insensitive' } },
        { skuCode: q },
        { barcode: q },
      ];
    }
    if (query.category) where.category = query.category;
    if (query.status) where.status = query.status;

    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const [total, products] = await this.prisma.$transaction([
      this.prisma.product.count({ where }),
      this.prisma.product.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    const summary = await this.buildPriceSummary(user, products.map((p) => p.id));
    return {
      items: products.map((p) => ({ ...p, priceSummary: summary.get(p.id) ?? [] })),
      total,
    };
  }

  async create(user: AuthUser, dto: CreateProductDto): Promise<Product> {
    const dup = await this.prisma.product.findFirst({
      where: { tenantId: user.tenantId, skuCode: dto.skuCode },
      select: { id: true },
    });
    if (dup) throw new ConflictException(`商品编码「${dto.skuCode}」已存在（租户内唯一）`);

    return this.prisma.product.create({
      data: {
        tenantId: user.tenantId,
        skuCode: dto.skuCode,
        name: dto.name,
        category: dto.category,
        brand: dto.brand,
        baseUnit: dto.baseUnit,
        minUnit: dto.minUnit,
        packSize: dto.packSize,
        barcode: dto.barcode,
        abv: dto.abv,
        origin: dto.origin,
        supplier: dto.supplier,
        specText: dto.specText,
        highValue: dto.highValue ?? false,
        pinyinFirst: dto.pinyinFirst,
      },
    });
  }

  async detail(user: AuthUser, id: string): Promise<Product> {
    const product = await this.prisma.product.findFirst({
      where: { id, tenantId: user.tenantId },
    });
    if (!product) throw new NotFoundException('商品不存在');
    return product;
  }

  async update(user: AuthUser, id: string, dto: UpdateProductDto, ip?: string): Promise<Product> {
    const before = await this.prisma.product.findFirst({
      where: { id, tenantId: user.tenantId },
    });
    if (!before) throw new NotFoundException('商品不存在');

    const data: Prisma.ProductUpdateInput = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.category !== undefined) data.category = dto.category;
    if (dto.brand !== undefined) data.brand = dto.brand;
    if (dto.baseUnit !== undefined) data.baseUnit = dto.baseUnit;
    if (dto.minUnit !== undefined) data.minUnit = dto.minUnit;
    if (dto.packSize !== undefined) data.packSize = dto.packSize;
    if (dto.barcode !== undefined) data.barcode = dto.barcode;
    if (dto.abv !== undefined) data.abv = dto.abv;
    if (dto.origin !== undefined) data.origin = dto.origin;
    if (dto.supplier !== undefined) data.supplier = dto.supplier;
    if (dto.specText !== undefined) data.specText = dto.specText;
    if (dto.highValue !== undefined) data.highValue = dto.highValue;
    if (dto.pinyinFirst !== undefined) data.pinyinFirst = dto.pinyinFirst;

    const after = await this.prisma.product.update({ where: { id }, data });
    try {
      await this.audit.log({
        user,
        action: AuditAction.MASTER_UPDATE,
        entityType: 'Product',
        entityId: id,
        before: this.auditFields(before),
        after: this.auditFields(after),
        ip,
      });
    } catch {
      // 审计失败不阻断业务（B2 哈希链异常单独告警）
    }
    return after;
  }

  /** 停售：历史单据/价格行仍引用档案，只下架不物理删 */
  async disable(user: AuthUser, id: string, ip?: string): Promise<Product> {
    const before = await this.prisma.product.findFirst({
      where: { id, tenantId: user.tenantId },
    });
    if (!before) throw new NotFoundException('商品不存在');

    const after = await this.prisma.product.update({
      where: { id },
      data: { status: ProductStatus.OFF_SALE },
    });
    try {
      await this.audit.log({
        user,
        action: AuditAction.MASTER_UPDATE,
        entityType: 'Product',
        entityId: id,
        before: this.auditFields(before),
        after: this.auditFields(after),
        ip,
      });
    } catch {
      // 审计失败不阻断业务
    }
    return after;
  }

  /** 批量取各商品当前生效价概要（COST 仅老板可见） */
  private async buildPriceSummary(
    user: AuthUser,
    productIds: string[],
  ): Promise<Map<string, PriceSummaryItem[]>> {
    const map = new Map<string, PriceSummaryItem[]>();
    if (productIds.length === 0) return map;
    const now = new Date();
    const rows = await this.prisma.price.findMany({
      where: {
        tenantId: user.tenantId,
        productId: { in: productIds },
        validFrom: { lte: now },
        OR: [{ validTo: null }, { validTo: { gte: now } }],
      },
      orderBy: [{ validFrom: 'desc' }, { createdAt: 'desc' }],
    });
    const seen = new Set<string>();
    for (const row of rows) {
      if (String(user.role) !== 'OWNER' && row.levelType === PriceLevelType.COST) continue;
      const key = `${row.productId}:${row.unit}:${row.levelType}`;
      if (seen.has(key)) continue; // 同键只保留最新生效版本
      seen.add(key);
      const list = map.get(row.productId) ?? [];
      list.push({ unit: row.unit, levelType: row.levelType, price: row.price, validFrom: row.validFrom });
      map.set(row.productId, list);
    }
    return map;
  }

  /** 审计负载只取 JSON 安全字段（Decimal 不入审计） */
  private auditFields(p: Product): Record<string, unknown> {
    return {
      name: p.name,
      category: p.category,
      brand: p.brand,
      baseUnit: p.baseUnit,
      minUnit: p.minUnit,
      packSize: p.packSize,
      barcode: p.barcode,
      abv: p.abv,
      origin: p.origin,
      supplier: p.supplier,
      specText: p.specText,
      highValue: p.highValue,
      status: p.status,
      pinyinFirst: p.pinyinFirst,
    };
  }
}
