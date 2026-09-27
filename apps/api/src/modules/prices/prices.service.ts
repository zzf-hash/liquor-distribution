// P0-T11 五级价 + 一客一价：
//   版本化——新价格只插入新行（D08），不更新旧行，订单明细价格快照因此不受调价影响；
//   取价引擎 resolve——客户专属价 > TERMINAL > TIER2 > TIER1 > RETAIL，取 validFrom<=now 且未失效的最新一条。
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CustomerPrice, Price, PriceLevelType, PriceUnit, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditAction, AuditService } from '../../audit/audit.service';
import type { AuthUser } from '../../common/current-user.decorator';
import { CreateCustomerPriceDto, CreateProductPriceDto, ResolvePriceDto } from './dto';

export interface ResolvedPrice {
  price: Prisma.Decimal;
  priceType: 'CUSTOMER_EXCLUSIVE' | PriceLevelType;
  priceRowId: string;
  validFrom: Date;
}

/** 全局价链取价优先级（COST 为内部成本，不对外取价） */
const RESOLVE_PRIORITY: PriceLevelType[] = [
  PriceLevelType.TERMINAL,
  PriceLevelType.TIER2,
  PriceLevelType.TIER1,
  PriceLevelType.RETAIL,
];

@Injectable()
export class PricesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** 商品五级价版本列表（COST 仅 OWNER 可见） */
  async listForProduct(user: AuthUser, productId: string): Promise<Price[]> {
    const product = await this.prisma.product.findFirst({
      where: { id: productId, tenantId: user.tenantId },
      select: { id: true },
    });
    if (!product) throw new NotFoundException('商品不存在');
    const rows = await this.prisma.price.findMany({
      where: { tenantId: user.tenantId, productId },
      orderBy: [{ validFrom: 'desc' }, { createdAt: 'desc' }],
    });
    if (String(user.role) === 'OWNER') return rows;
    return rows.filter((r) => r.levelType !== PriceLevelType.COST);
  }

  /** 新增商品价格版本（不更新旧行）；同 (unit,levelType,validFrom) 重复 → 409 */
  async createForProduct(
    user: AuthUser,
    productId: string,
    dto: CreateProductPriceDto,
    ip?: string,
  ): Promise<Price> {
    const product = await this.prisma.product.findFirst({
      where: { id: productId, tenantId: user.tenantId },
      select: { id: true },
    });
    if (!product) throw new NotFoundException('商品不存在');
    if (dto.levelType === PriceLevelType.COST && String(user.role) !== 'OWNER') {
      throw new ForbiddenException('成本价仅老板可维护');
    }
    const { validFrom, validTo } = this.parseRange(dto);
    const dup = await this.prisma.price.findFirst({
      where: {
        tenantId: user.tenantId,
        productId,
        unit: dto.unit,
        levelType: dto.levelType,
        validFrom,
      },
      select: { id: true },
    });
    if (dup) throw new ConflictException('同一计价单位×价格级别在该生效日已有版本（价格只新增不覆盖）');

    let created: Price;
    try {
      created = await this.prisma.price.create({
        data: {
          tenantId: user.tenantId,
          productId,
          unit: dto.unit,
          levelType: dto.levelType,
          price: new Prisma.Decimal(dto.price),
          validFrom,
          validTo,
          approvalRef: dto.approvalRef,
          note: dto.note,
          createdBy: user.id,
        },
      });
    } catch (e) {
      throw this.toConflict(e, '价格版本');
    }
    try {
      await this.audit.log({
        user,
        action: AuditAction.PRICE_CHANGE,
        entityType: 'Price',
        entityId: created.id,
        before: null,
        after: {
          productId,
          unit: dto.unit,
          levelType: dto.levelType,
          price: dto.price,
          validFrom: dto.validFrom,
          validTo: dto.validTo ?? null,
          approvalRef: dto.approvalRef ?? null,
        },
        ip,
      });
    } catch {
      // 审计失败不阻断业务
    }
    return created;
  }

  /** 客户专属价版本列表（带商品概要） */
  async listForCustomer(
    user: AuthUser,
    customerId: string,
  ): Promise<Array<CustomerPrice & { product: { skuCode: string; name: string } }>> {
    const customer = await this.prisma.customer.findFirst({
      where: { id: customerId, tenantId: user.tenantId },
      select: { id: true },
    });
    if (!customer) throw new NotFoundException('客户不存在');
    return this.prisma.customerPrice.findMany({
      where: { tenantId: user.tenantId, customerId },
      orderBy: [{ validFrom: 'desc' }, { createdAt: 'desc' }],
      include: { product: { select: { skuCode: true, name: true } } },
    });
  }

  /** 新增客户专属价版本；无审批单号给 WARN 不阻断（记 note 留痕） */
  async createForCustomer(
    user: AuthUser,
    customerId: string,
    dto: CreateCustomerPriceDto,
    ip?: string,
  ): Promise<CustomerPrice> {
    const customer = await this.prisma.customer.findFirst({
      where: { id: customerId, tenantId: user.tenantId },
      select: { id: true },
    });
    if (!customer) throw new NotFoundException('客户不存在');
    const product = await this.prisma.product.findFirst({
      where: { id: dto.productId, tenantId: user.tenantId },
      select: { id: true },
    });
    if (!product) throw new BadRequestException('商品不存在（专属价须先有商品档案）');

    const { validFrom, validTo } = this.parseRange(dto);
    const dup = await this.prisma.customerPrice.findFirst({
      where: {
        tenantId: user.tenantId,
        customerId,
        productId: dto.productId,
        unit: dto.unit,
        validFrom,
      },
      select: { id: true },
    });
    if (dup) throw new ConflictException('该商品×计价单位在该生效日已有专属价版本');

    // §3 专属价必须带审批单号：缺失不阻断，但把警告写进 note 待商户确认（导入模板口径）
    const note = dto.approvalRef
      ? dto.note
      : [dto.note, '[警告] 无审批单号（专属价原则上须带审批单号）'].filter(Boolean).join('｜');

    let created: CustomerPrice;
    try {
      created = await this.prisma.customerPrice.create({
        data: {
          tenantId: user.tenantId,
          customerId,
          productId: dto.productId,
          unit: dto.unit,
          price: new Prisma.Decimal(dto.price),
          validFrom,
          validTo,
          approvalRef: dto.approvalRef,
          note,
          createdBy: user.id,
        },
      });
    } catch (e) {
      throw this.toConflict(e, '专属价版本');
    }
    try {
      await this.audit.log({
        user,
        action: AuditAction.PRICE_CHANGE,
        entityType: 'CustomerPrice',
        entityId: created.id,
        before: null,
        after: {
          customerId,
          productId: dto.productId,
          unit: dto.unit,
          price: dto.price,
          validFrom: dto.validFrom,
          validTo: dto.validTo ?? null,
          approvalRef: dto.approvalRef ?? null,
          warning: dto.approvalRef ? null : '无审批单号',
        },
        ip,
      });
    } catch {
      // 审计失败不阻断业务
    }
    return created;
  }

  /** 取价引擎（只读）：客户专属价 > TERMINAL > TIER2 > TIER1 > RETAIL */
  async resolve(user: AuthUser, query: ResolvePriceDto): Promise<ResolvedPrice> {
    const unit = query.unit ?? PriceUnit.BASE;
    const now = new Date();

    // ① 客户专属价
    const exclusive = await this.prisma.customerPrice.findFirst({
      where: {
        tenantId: user.tenantId,
        customerId: query.customerId,
        productId: query.productId,
        unit,
        validFrom: { lte: now },
        OR: [{ validTo: null }, { validTo: { gte: now } }],
      },
      orderBy: { validFrom: 'desc' },
    });
    if (exclusive) {
      return {
        price: exclusive.price,
        priceType: 'CUSTOMER_EXCLUSIVE',
        priceRowId: exclusive.id,
        validFrom: exclusive.validFrom,
      };
    }

    // ② 全局价链按优先级取最新生效版本
    const rows = await this.prisma.price.findMany({
      where: {
        tenantId: user.tenantId,
        productId: query.productId,
        unit,
        levelType: { in: RESOLVE_PRIORITY },
        validFrom: { lte: now },
        OR: [{ validTo: null }, { validTo: { gte: now } }],
      },
      orderBy: { validFrom: 'desc' },
    });
    for (const level of RESOLVE_PRIORITY) {
      const row = rows.find((r) => r.levelType === level);
      if (row) {
        return { price: row.price, priceType: row.levelType, priceRowId: row.id, validFrom: row.validFrom };
      }
    }
    throw new NotFoundException('无生效价：该客户×商品×计价单位下未配置任何生效价格');
  }

  /** 失效日不得早于生效日；同时转 Date（商品价/客户专属价共用） */
  private parseRange(dto: { validFrom: string; validTo?: string }): { validFrom: Date; validTo?: Date } {
    const validFrom = new Date(dto.validFrom);
    const validTo = dto.validTo ? new Date(dto.validTo) : undefined;
    if (Number.isNaN(validFrom.getTime())) throw new BadRequestException('生效日格式错误');
    if (validTo && Number.isNaN(validTo.getTime())) throw new BadRequestException('失效日格式错误');
    if (validTo && validTo.getTime() < validFrom.getTime()) {
      throw new BadRequestException('失效日不能早于生效日');
    }
    return { validFrom, validTo };
  }

  /** 唯一索引兜底（并发同刻插入）转 409 */
  private toConflict(e: unknown, what: string): Error {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      return new ConflictException(`${what}已存在（唯一键冲突）`);
    }
    return e instanceof Error ? e : new Error(String(e));
  }
}
