import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import dayjs from 'dayjs';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../../audit/audit.service';
import { ApprovalsService } from '../approvals/approvals.service';
import { OrdersService } from '../orders/orders.service';
import type { AuthUser } from '../../common/current-user.decorator';

// ═══════════════ P1-T02 特单 (F8 全员下单 + 婚宴宴席单) ═══════════════
// 红线: 未经定价审批不可出货 → convert 仅 APPROVED 可转正式订单(D01/任务书验收)
// 特单信号(D1): ①低于可用价 ②非默认地址 ③指定配送时段 ④宴席/活动 ⑤回款超账期

@Injectable()
export class SpecialOrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly approvals: ApprovalsService,
    private readonly orders: OrdersService,
  ) {}

  async create(user: AuthUser, dto: {
    title: string; customerId?: string; customerName: string; isBanquet?: boolean;
    eventDate?: string; venue?: string; contactName: string; contactPhone: string;
    address: string; deliveryDate?: string; payeeName?: string; payDueDate?: string; note?: string;
    lines: Array<{ productId?: string; productName: string; specText?: string; unit: string; qty: number; price: number; note?: string }>;
  }): Promise<unknown> {
    if (!dto.lines?.length) throw new BadRequestException('特单至少一行');
    if (dto.lines.some((l) => l.qty <= 0 || l.price < 0)) throw new BadRequestException('数量须>0, 价格须≥0');
    const seq = (await this.prisma.specialOrder.count({ where: { specialNo: { startsWith: `SP${dayjs().format('YYYYMMDD')}` } } })) + 1;
    const created = await this.prisma.specialOrder.create({
      data: {
        tenantId: user.tenantId,
        specialNo: `SP${dayjs().format('YYYYMMDD')}-${String(seq).padStart(4, '0')}`,
        title: dto.title, customerId: dto.customerId, customerName: dto.customerName,
        isBanquet: dto.isBanquet ?? false,
        eventDate: dto.eventDate ? new Date(dto.eventDate) : undefined, venue: dto.venue,
        contactName: dto.contactName, contactPhone: dto.contactPhone, address: dto.address,
        deliveryDate: dto.deliveryDate ? new Date(dto.deliveryDate) : undefined,
        payeeName: dto.payeeName, payDueDate: dto.payDueDate ? new Date(dto.payDueDate) : undefined,
        note: dto.note, status: 'DRAFT', createdById: user.id,
        lines: { create: dto.lines.map((l) => ({ tenantId: user.tenantId, productId: l.productId, productName: l.productName, specText: l.specText, unit: l.unit, qty: new Prisma.Decimal(l.qty), price: new Prisma.Decimal(l.price), note: l.note })) },
      } as never,
      include: { lines: true },
    });
    await this.audit.log({ user, action: 'SPECIAL_CREATE', entityType: 'SPECIAL_ORDER', entityId: created.id, after: { specialNo: created.specialNo, title: dto.title, lines: dto.lines.length } });
    return created;
  }

  async list(user: AuthUser, q: { status?: string; keyword?: string; page?: number; pageSize?: number }): Promise<unknown> {
    const page = Math.max(1, q.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, q.pageSize ?? 20));
    const where: Prisma.SpecialOrderWhereInput = {
      status: q.status as never,
      OR: q.keyword ? [{ specialNo: { contains: q.keyword } }, { title: { contains: q.keyword } }, { customerName: { contains: q.keyword } }] : undefined,
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.specialOrder.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize, include: { lines: true } }),
      this.prisma.specialOrder.count({ where }),
    ]);
    void user;
    return { items, total };
  }

  async detail(id: string): Promise<unknown> {
    const so = await this.prisma.specialOrder.findUnique({ where: { id }, include: { lines: true } });
    if (!so) throw new NotFoundException('特单不存在');
    return so;
  }

  /** 提交定价审批: → PENDING_PRICE + 审批中心待办(PRICE_SPECIAL 线, 金额=行合计) */
  async submit(user: AuthUser, id: string, reason: string): Promise<unknown> {
    const so = await this.prisma.specialOrder.findUnique({ where: { id }, include: { lines: true } });
    if (!so) throw new NotFoundException('特单不存在');
    if (so.status !== 'DRAFT') throw new ConflictException(`仅草稿可提交审批(当前 ${so.status})`);
    if (!reason?.trim()) throw new BadRequestException('提交审批必须填写理由');
    const amount = so.lines.reduce((s, l) => s + Number(l.qty) * Number(l.price), 0);
    // 特单信号检测(D1): 低于客户可用价(引用商品行) / 宴席 / 指定时段
    const signals: string[] = [];
    if (so.isBanquet) signals.push('宴席/活动用酒');
    if (so.deliveryDate) signals.push('指定配送时段');
    if (so.customerId) {
      for (const l of so.lines.filter((x) => x.productId)) {
        const resolved = await this.resolveAvailablePrice(so.customerId, l.productId!);
        if (resolved !== null && Number(l.price) < resolved) { signals.push(`行「${l.productName}」低于可用价 ${resolved}`); break; }
      }
    }
    await this.prisma.specialOrder.update({ where: { id }, data: { status: 'PENDING_PRICE' } });
    const approval = await this.approvals.create(user, {
      line: 'PRICE_SPECIAL', entityType: 'SPECIAL_ORDER', entityId: id,
      title: `特单定价 ${so.specialNo} ${so.title}`, amount, reason,
      payload: { specialNo: so.specialNo, signals, lines: so.lines.map((l) => ({ name: l.productName, qty: Number(l.qty), price: Number(l.price) })) },
    });
    await this.audit.log({ user, action: 'SPECIAL_SUBMIT', entityType: 'SPECIAL_ORDER', entityId: id, after: { specialNo: so.specialNo, amount, signals } });
    return { id, status: 'PENDING_PRICE', approvalId: approval.id, amount, signals };
  }

  private async resolveAvailablePrice(customerId: string, productId: string): Promise<number | null> {
    const now = new Date();
    const valid = { validFrom: { lte: now }, OR: [{ validTo: null }, { validTo: { gte: now } }] };
    const exclusive = await this.prisma.customerPrice.findFirst({ where: { customerId, productId, ...valid }, orderBy: { validFrom: 'desc' } });
    if (exclusive) return Number(exclusive.price);
    const order: Array<'TERMINAL' | 'TIER2' | 'TIER1' | 'RETAIL'> = ['TERMINAL', 'TIER2', 'TIER1', 'RETAIL'];
    for (const level of order) {
      const row = await this.prisma.price.findFirst({ where: { productId, levelType: level, ...valid }, orderBy: { validFrom: 'desc' } });
      if (row) return Number(row.price);
    }
    return null;
  }

  /** 转正式订单: 仅 APPROVED(红线闸门); 仅引用商品的行转单(自由品名行留档不入正式单) */
  async convert(user: AuthUser, id: string): Promise<unknown> {
    const so = await this.prisma.specialOrder.findUnique({ where: { id }, include: { lines: true } });
    if (!so) throw new NotFoundException('特单不存在');
    if (so.status !== 'APPROVED') throw new ConflictException('未经定价审批不可出货(P1-T02 红线), 仅 APPROVED 可转单');
    if (so.convertedOrderId) throw new ConflictException('该特单已转单');
    if (!so.customerId) throw new ConflictException('缺少客户档案, 请先补建客户档案再转单');
    const productLines = so.lines.filter((l) => l.productId);
    if (productLines.length === 0) throw new ConflictException('无可转单的商品行(自由品名行不入正式订单)');
    const approval = await this.prisma.approvalRecord.findFirst({ where: { entityType: 'SPECIAL_ORDER', entityId: id, status: 'APPROVED' }, orderBy: { createdAt: 'desc' } });
    const order = await this.orders.create(
      {
        customerId: so.customerId,
        source: user.role === 'REP' ? 'REP' : 'CLERK',
        lines: productLines.map((l) => ({ productId: l.productId!, qty: Number(l.qty), unit: 'BASE', priceOverride: Number(l.price) })),
        addressOverride: so.address,
        deliveryDate: so.deliveryDate ? dayjs(so.deliveryDate).format('YYYY-MM-DD') : undefined,
        note: `特单 ${so.specialNo} 转单${so.isBanquet ? '(宴席)' : ''}`,
      },
      user,
    );
    await this.prisma.specialOrder.update({ where: { id }, data: { status: 'CONVERTED', convertedOrderId: (order as { id: string }).id } });
    await this.audit.log({ user, action: 'SPECIAL_CONVERT', entityType: 'SPECIAL_ORDER', entityId: id, after: { specialNo: so.specialNo, orderNo: (order as { orderNo: string }).orderNo, approvalId: approval?.id } });
    return { specialNo: so.specialNo, orderId: (order as { id: string }).id, orderNo: (order as { orderNo: string }).orderNo };
  }
}
