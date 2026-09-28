import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../../audit/audit.service';
import type { AuthUser } from '../../common/current-user.decorator';

// ═══════════════ P1-T04 回包装闭环 ═══════════════
// 有单回填(签收联动) + F11 无单回收 + 押金退付冲减; 台账 append-only(PackageRecord 只增)
// 押金单价: cfg key = deposit_<品类拼音或原名>, 默认表(商户签字后可调)
// 押金余额 = Σ(STANDALONE+WITH_ORDER 的 depositPaid) − Σ(OUT 的 depositPaid)

const DEFAULT_DEPOSITS: Record<string, number> = { 周转箱: 15, 啤酒瓶: 0.5, 白酒盒: 2 };

@Injectable()
export class PackagesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async depositUnit(category: string): Promise<number> {
    const row = await this.prisma.systemConfig.findFirst({ where: { key: `deposit_${category}` } });
    const v = row ? Number((row.value as { v?: unknown })?.v ?? row.value) : NaN;
    return Number.isFinite(v) ? v : (DEFAULT_DEPOSITS[category] ?? 0);
  }

  async create(user: AuthUser, dto: { customerId: string; category: string; qty: number; type: 'WITH_ORDER' | 'STANDALONE' | 'OUT'; orderId?: string; note?: string }, idemKey?: string): Promise<unknown> {
    if (dto.qty <= 0 || !Number.isInteger(dto.qty)) throw new BadRequestException('数量须为正整数');
    if (!dto.category?.trim()) throw new BadRequestException('品类必填');
    const customer = await this.prisma.customer.findUnique({ where: { id: dto.customerId } });
    if (!customer) throw new NotFoundException('客户不存在');
    if (dto.type === 'OUT') {
      // 押金退付: 校验余额足够(数量口径)
      const bal = await this.balanceOf(dto.customerId, dto.category);
      if (bal.qty < dto.qty) throw new BadRequestException(`押金退付超余额(当前 ${bal.qty})`);
    }
    const unit = await this.depositUnit(dto.category);
    const depositPaid = dto.type === 'OUT' ? -Number((unit * dto.qty).toFixed(2)) : Number((unit * dto.qty).toFixed(2));
    if (idemKey) {
      const dup = await this.prisma.idempotencyRecord.findUnique({ where: { tenantId_key: { tenantId: user.tenantId, key: idemKey } } });
      if (dup) return { replay: true, summary: dup.responseSummary };
    }
    const created = await this.prisma.packageRecord.create({
      data: {
        tenantId: user.tenantId, customerId: dto.customerId, category: dto.category, qty: dto.qty,
        type: dto.type, orderId: dto.orderId, depositPaid: new Prisma.Decimal(depositPaid),
        note: dto.note, recordedById: user.id,
      },
    });
    if (idemKey) {
      await this.prisma.idempotencyRecord.create({
        data: { tenantId: user.tenantId, key: idemKey, endpoint: 'packages.create', requestHash: JSON.stringify({ c: dto.customerId, k: dto.category, q: dto.qty, t: dto.type }), createdBy: user.id, responseSummary: { id: created.id } as never },
      });
    }
    await this.audit.log({ user, action: 'PACKAGE_RECORD', entityType: 'PackageRecord', entityId: created.id, after: { customer: customer.name, category: dto.category, qty: dto.qty, type: dto.type, depositPaid } });
    return { id: created.id, category: dto.category, qty: dto.qty, type: dto.type, depositPaid };
  }

  private async balanceOf(customerId: string, category: string): Promise<{ qty: number; deposit: number }> {
    const rows = await this.prisma.packageRecord.findMany({ where: { customerId, category } });
    let qty = 0; let deposit = 0;
    for (const r of rows) {
      const sign = r.type === 'OUT' ? -1 : 1;
      qty += sign * r.qty;
      deposit += sign * Number(r.depositPaid);
    }
    return { qty, deposit };
  }

  /** 押金台账汇总(按品类全局) */
  async summary(): Promise<unknown> {
    const rows = await this.prisma.packageRecord.findMany({ select: { category: true, qty: true, type: true, depositPaid: true } });
    const map = new Map<string, { category: string; qty: number; deposit: number }>();
    for (const r of rows) {
      const sign = r.type === 'OUT' ? -1 : 1;
      const cur = map.get(r.category) ?? { category: r.category, qty: 0, deposit: 0 };
      cur.qty += sign * r.qty;
      cur.deposit += sign * Number(r.depositPaid);
      map.set(r.category, cur);
    }
    const items = [...map.values()];
    return { items, totalDeposit: Number(items.reduce((s, i) => s + i.deposit, 0).toFixed(2)) };
  }

  async list(q: { customerId?: string; category?: string; type?: string; page?: number; pageSize?: number }): Promise<unknown> {
    const page = Math.max(1, q.page ?? 1);
    const pageSize = Math.min(200, Math.max(1, q.pageSize ?? 50));
    const where = {
      customerId: q.customerId, category: q.category,
      type: q.type as never,
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.packageRecord.findMany({
        where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize,
        include: { customer: { select: { code: true, name: true } } },
      }),
      this.prisma.packageRecord.count({ where }),
    ]);
    return { items, total };
  }
}
