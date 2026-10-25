import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { sequential } from '../../prisma/relation-read';
import { AuditService } from '../../audit/audit.service';
import { IdempotencyService } from '../../audit/idempotency.service';
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
    private readonly idem: IdempotencyService,
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
    const pPayload = { c: dto.customerId, k: dto.category, q: dto.qty, t: dto.type };
    const dup = await this.idem.check(user, 'packages.create', idemKey ?? '', pPayload);
    if (dup) return { replay: true, summary: dup.summary };
    const unit = await this.depositUnit(dto.category);
    const depositPaid = dto.type === 'OUT' ? -Number((unit * dto.qty).toFixed(2)) : Number((unit * dto.qty).toFixed(2));
    let created: { id: string };
    if (dto.type === 'OUT') {
      // 押金退付: 事务内行锁 + 余额复核(2026-10 审查修复: 原余额校验在事务外且幂等记录
      // 与业务不同事务, 并发双退可超额退付)
      created = await this.prisma.$transaction(async (tx) => {
        // 锁定该客户该品类的台账行, 串行化并发退付(锁内重算余额, READ COMMITTED 下可读到对方已提交行)
        await tx.$queryRaw`SELECT id FROM "PackageRecord" WHERE "tenantId" = ${user.tenantId} AND "customerId" = ${dto.customerId} AND category = ${dto.category} FOR UPDATE`;
        const bal = await this.balanceOfTx(tx, dto.customerId, dto.category);
        if (bal.qty < dto.qty) throw new BadRequestException(`押金退付超余额(当前 ${bal.qty})`);
        return tx.packageRecord.create({
          data: {
            tenantId: user.tenantId, customerId: dto.customerId, category: dto.category, qty: dto.qty,
            type: dto.type, orderId: dto.orderId, depositPaid: new Prisma.Decimal(depositPaid),
            note: dto.note, recordedById: user.id,
          },
        });
      });
    } else {
      created = await this.prisma.packageRecord.create({
        data: {
          tenantId: user.tenantId, customerId: dto.customerId, category: dto.category, qty: dto.qty,
          type: dto.type, orderId: dto.orderId, depositPaid: new Prisma.Decimal(depositPaid),
          note: dto.note, recordedById: user.id,
        },
      });
    }
    if (idemKey) {
      await this.idem.complete(user, 'packages.create', idemKey, pPayload, { id: created.id });
    }
    await this.audit.log({ user, action: 'PACKAGE_RECORD', entityType: 'PackageRecord', entityId: created.id, after: { customer: customer.name, category: dto.category, qty: dto.qty, type: dto.type, depositPaid } });
    return { id: created.id, category: dto.category, qty: dto.qty, type: dto.type, depositPaid };
  }

  private async balanceOfTx(tx: Pick<PrismaService, 'packageRecord'>, customerId: string, category: string): Promise<{ qty: number; deposit: number }> {
    const rows = await tx.packageRecord.findMany({ where: { customerId, category } });
    let qty = 0; let deposit = 0;
    for (const r of rows) {
      // IN 类 depositPaid 为正、OUT 类存负值 → 直接累加(2026-10 审查修复: 原按 type 再乘 ±1,
      // 负负得正, 每笔退付反而使押金余额增加)
      qty += r.type === 'OUT' ? -r.qty : r.qty;
      deposit += Number(r.depositPaid);
    }
    return { qty, deposit };
  }

  private async balanceOf(customerId: string, category: string): Promise<{ qty: number; deposit: number }> {
    return this.balanceOfTx(this.prisma, customerId, category);
  }

  /** 押金台账汇总(按品类全局) */
  async summary(): Promise<unknown> {
    const rows = await this.prisma.packageRecord.findMany({ select: { category: true, qty: true, type: true, depositPaid: true } });
    const map = new Map<string, { category: string; qty: number; deposit: number }>();
    for (const r of rows) {
      const cur = map.get(r.category) ?? { category: r.category, qty: 0, deposit: 0 };
      // 与 balanceOf 同口径: depositPaid 直接累加(OUT 行已存负值), 仅数量按 type 取反
      cur.qty += r.type === 'OUT' ? -r.qty : r.qty;
      cur.deposit += Number(r.depositPaid);
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
    const [items, total] = await sequential([
      this.prisma.packageRecord.findMany({
        where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize,
        include: { customer: { select: { code: true, name: true } } },
      }),
      this.prisma.packageRecord.count({ where }),
    ]);
    return { items, total };
  }
}
