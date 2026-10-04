import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import dayjs from 'dayjs';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../../audit/audit.service';
import { ApprovalsService } from '../approvals/approvals.service';
import type { AuthUser } from '../../common/current-user.decorator';

// ═══════════════ P1-T05 调价引擎 (F7) ═══════════════
// D08: 价格只新增版本不覆盖历史(生效=插入新 Price 行 validFrom=生效日), 历史单据不受影响(快照物理脱钩)
// R7/D15: 存货增贬值只测算登记(stockImpact), 不做自动估值调账
// 审批: PRICE_CHANGE 线(≤2000 内勤/>2000 老板, 审批中心统一)

@Injectable()
export class PriceChangesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly approvals: ApprovalsService,
  ) {}

  async create(user: AuthUser, dto: { productId: string; unit: 'BASE' | 'MIN'; levelType: string; newPrice: number; effectiveDate: string; reason: string; customerSync?: boolean }): Promise<unknown> {
    if (dto.levelType === 'COST' && user.role !== 'OWNER') throw new ConflictException('成本价调价仅老板可发起');
    if (dto.newPrice < 0) throw new BadRequestException('新价不能为负');
    if (!dto.reason?.trim()) throw new BadRequestException('调价必须填写理由');
    const product = await this.prisma.product.findUnique({ where: { id: dto.productId } });
    if (!product) throw new NotFoundException('商品不存在');
    const effective = new Date(dto.effectiveDate);
    if (Number.isNaN(effective.getTime())) throw new BadRequestException('生效日格式错');
    // #25: 调价不允许回溯生效——生效日早于今天会在 effectuate 时插入一条 validFrom 在历史区间的版本,
    // 被取价引擎的"最新 validFrom"静默淹没(或错误改写历史口径订单的取价)。退改须走新调价单。
    const todayStart = dayjs().startOf('day').toDate();
    if (effective < todayStart) throw new BadRequestException('生效日不能早于今天(不允许回溯调价)');
    // 旧价快照: 当前最新生效价
    const oldRow = await this.prisma.price.findFirst({
      where: { productId: dto.productId, unit: dto.unit, levelType: dto.levelType as never, validFrom: { lte: new Date() }, OR: [{ validTo: null }, { validTo: { gte: new Date() } }] },
      orderBy: { validFrom: 'desc' },
    });
    const oldPrice = Number(oldRow?.price ?? 0);
    // 存货增贬值测算(登记不调账): 在库量×价差
    const groups = await this.prisma.inventoryLedger.groupBy({
      by: ['direction'], where: { productId: dto.productId }, _sum: { qty: true },
    });
    const onHandQty = groups.reduce((s, g) => s + (g.direction === 'IN' ? Number(g._sum.qty ?? 0) : -Number(g._sum.qty ?? 0)), 0);
    const stockImpact = { onHandQty, oldPrice, newPrice: dto.newPrice, deltaAmount: Number((onHandQty * (dto.newPrice - oldPrice)).toFixed(2)) };
    const created = await this.prisma.priceChangeRequest.create({
      data: {
        tenantId: user.tenantId, productId: dto.productId, unit: dto.unit, levelType: dto.levelType as never,
        oldPrice: new Prisma.Decimal(oldPrice), newPrice: new Prisma.Decimal(dto.newPrice),
        effectiveDate: effective, reason: dto.reason, stockImpact: stockImpact as never,
        customerSync: dto.customerSync ?? false, status: 'DRAFT', createdById: user.id,
      },
    });
    await this.audit.log({ user, action: 'PRICE_CHANGE_CREATE', entityType: 'PRICE_CHANGE', entityId: created.id, before: { oldPrice }, after: { newPrice: dto.newPrice, effectiveDate: dto.effectiveDate, stockImpact } });
    return { ...created, stockImpact };
  }

  async submit(user: AuthUser, id: string): Promise<unknown> {
    const r = await this.prisma.priceChangeRequest.findUnique({ where: { id } });
    if (!r) throw new NotFoundException('调价单不存在');
    if (r.status !== 'DRAFT') throw new ConflictException(`仅草稿可提交(当前 ${r.status})`);
    const product = await this.prisma.product.findUnique({ where: { id: r.productId } });
    const approval = await this.approvals.create(user, {
      line: 'PRICE_CHANGE', entityType: 'PRICE_CHANGE', entityId: id,
      title: `调价 ${product?.name ?? r.productId} ${r.levelType} ¥${Number(r.oldPrice)}→¥${Number(r.newPrice)}`,
      amount: Number(r.stockImpact ? (r.stockImpact as { deltaAmount?: number }).deltaAmount ?? 0 : 0),
      reason: r.reason,
      payload: { productId: r.productId, unit: r.unit, levelType: r.levelType, oldPrice: Number(r.oldPrice), newPrice: Number(r.newPrice), effectiveDate: dayjs(r.effectiveDate).format('YYYY-MM-DD'), stockImpact: r.stockImpact },
    });
    await this.prisma.priceChangeRequest.update({ where: { id }, data: { status: 'PENDING', approvalId: approval.id } });
    return { id, status: 'PENDING', approvalId: approval.id };
  }

  /** 一键生效: 审批通过后插入新价格版本行(D08: 不覆盖历史) */
  async effectuate(user: AuthUser, id: string): Promise<unknown> {
    const r = await this.prisma.priceChangeRequest.findUnique({ where: { id } });
    if (!r) throw new NotFoundException('调价单不存在');
    if (r.status === 'EFFECTIVE') throw new ConflictException('该调价已生效(幂等拒绝)');
    if (r.status !== 'APPROVED') throw new ConflictException('审批通过后才可生效');
    const price = await this.prisma.price.create({
      data: {
        tenantId: user.tenantId, productId: r.productId, unit: r.unit, levelType: r.levelType,
        price: r.newPrice, validFrom: r.effectiveDate, approvalRef: `PC-${id.slice(0, 8)}`,
        note: `调价生效: ${r.reason}`, createdBy: user.id,
      },
    });
    await this.prisma.priceChangeRequest.update({ where: { id }, data: { status: 'EFFECTIVE', effectuatedAt: new Date() } });
    await this.audit.log({ user, action: 'PRICE_CHANGE_EFFECT', entityType: 'PRICE_CHANGE', entityId: id, after: { priceRowId: price.id, validFrom: r.effectiveDate, newPrice: Number(r.newPrice) } });
    return { id, status: 'EFFECTIVE', priceRowId: price.id };
  }

  async list(q: { status?: string; page?: number; pageSize?: number }): Promise<unknown> {
    const page = Math.max(1, q.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, q.pageSize ?? 20));
    const where = { status: q.status as never };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.priceChangeRequest.findMany({
        where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize,
        include: { product: { select: { skuCode: true, name: true } } },
      }),
      this.prisma.priceChangeRequest.count({ where }),
    ]);
    return { items, total };
  }
}
