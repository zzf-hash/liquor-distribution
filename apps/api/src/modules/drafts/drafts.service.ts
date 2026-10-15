import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import dayjs from 'dayjs';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../../audit/audit.service';
import { OrdersService } from '../orders/orders.service';
import { QwenEngineService } from './qwen-engine.service';
import type { AuthUser } from '../../common/current-user.decorator';

// ═══════════════ P1-T12 语音/照片/文字 → 可编辑草稿 → 确认转单 ═══════════════
// 红线(D16/Q13): 草稿永远是可编辑的; confirm 只创建 PENDING_CONFIRM 订单(状态机
//   保证不可能直接出库); 低置信度(confidence < 0.7)前端强提示强制人工过目
// 别名学习: 确认转单时, 人工把 productName 映射到 productId 的修正回写词典(AUTO_LEARNED)
// 来电反查: 文本含电话 → AliasEntry(CUSTOMER, key=电话) 命中自动填 customerId

interface DraftItem {
  productName: string;
  productId?: string | null;
  qty: number;
  unit: string;
  unitPrice?: number | null;
  priceHint?: number | null;
  aliasMatched?: boolean;
}

const LOW_CONFIDENCE = 0.7;

@Injectable()
export class DraftsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly orders: OrdersService,
    private readonly engine: QwenEngineService,
  ) {}

  /** 创建草稿: 文本走 qwen 解析; 引擎失败 → 空草稿人工填(兜底为默认路径) */
  async create(user: AuthUser, dto: { source: 'VOICE' | 'PHOTO' | 'TEXT'; text?: string; photoUrl?: string }): Promise<unknown> {
    if (!dto.text && !dto.photoUrl) throw new BadRequestException('文本与照片至少一项');
    let customerHint: string | null = null;
    let items: DraftItem[] = [];
    let confidence = 0;
    let ambiguities: string[] = [];
    let engineTag = 'manual';
    if (dto.text?.trim()) {
      try {
        const parsed = await this.engine.parse(dto.text);
        customerHint = parsed.customerHint;
        confidence = parsed.confidence;
        ambiguities = parsed.ambiguities;
        engineTag = 'qwen3.8-27b';
        // 别名/电话解析
        const resolved = await this.resolveAliases(user, parsed.items, dto.text);
        items = resolved.items;
        const customerId = resolved.customerId;
        const seq = (await this.prisma.orderDraft.count({ where: { draftNo: { startsWith: `DF${dayjs().format('YYYYMMDD')}` } } })) + 1;
        const created = await this.prisma.orderDraft.create({
          data: {
            tenantId: user.tenantId,
            draftNo: `DF${dayjs().format('YYYYMMDD')}-${String(seq).padStart(4, '0')}`,
            source: dto.source, rawText: dto.text, photoUrl: dto.photoUrl,
            customerId, customerHint, items: items as never,
            confidence, ambiguities: (ambiguities.length ? ambiguities : undefined) as never,
            engine: engineTag, status: 'PENDING_REVIEW', createdById: user.id,
          },
        });
        await this.audit.log({ user, action: 'DRAFT_CREATE', entityType: 'OrderDraft', entityId: created.id, after: { draftNo: created.draftNo, source: dto.source, items: items.length, confidence, engine: engineTag } });
        return { ...created, lowConfidence: confidence < LOW_CONFIDENCE, needsManual: items.length === 0 };
      } catch (e) {
        ambiguities = [`引擎解析失败(${String(e).slice(0, 80)}), 已转人工填写`];
      }
    }
    const seq = (await this.prisma.orderDraft.count({ where: { draftNo: { startsWith: `DF${dayjs().format('YYYYMMDD')}` } } })) + 1;
    const created = await this.prisma.orderDraft.create({
      data: {
        tenantId: user.tenantId,
        draftNo: `DF${dayjs().format('YYYYMMDD')}-${String(seq).padStart(4, '0')}`,
        source: dto.source, rawText: dto.text, photoUrl: dto.photoUrl,
        customerHint, items: items as never, confidence, ambiguities: (ambiguities.length ? ambiguities : undefined) as never,
        engine: 'manual', status: 'PENDING_REVIEW', createdById: user.id,
      },
    });
    await this.audit.log({ user, action: 'DRAFT_CREATE', entityType: 'OrderDraft', entityId: created.id, after: { draftNo: created.draftNo, source: dto.source, fallback: true } });
    return { ...created, lowConfidence: true, needsManual: true };
  }

  /** 别名解析(商品) + 来电反查(客户电话) */
  private async resolveAliases(user: AuthUser, items: Array<{ productName: string; qty: number; unit: string; priceHint: number | null }>, text: string): Promise<{ items: DraftItem[]; customerId: string | null }> {
    // 商品: 别名词典精确命中 → 商品名包含
    const products = await this.prisma.product.findMany({ where: { status: 'ON_SALE' }, select: { id: true, name: true, skuCode: true } });
    const aliases = await this.prisma.aliasEntry.findMany({ where: { kind: 'PRODUCT' } });
    const out: DraftItem[] = items.map((i) => {
      const norm = i.productName.trim().toLowerCase();
      const aliasHit = aliases.find((a) => a.key.toLowerCase() === norm);
      let productId: string | null = aliasHit?.targetId ?? null;
      let aliasMatched = Boolean(aliasHit);
      if (!productId) {
        const byName = products.find((p) => p.name === i.productName) ?? products.find((p) => p.name.includes(i.productName) || i.productName.includes(p.name.split(/[\d度mlML×x]/)[0]?.slice(0, 2) ?? '###'));
        if (byName) productId = byName.id;
      }
      return { ...i, productId, aliasMatched, unitPrice: i.priceHint };
    });
    // 客户: 文本中的电话号码 → AliasEntry(CUSTOMER); 无则店名线索模糊匹配
    let customerId: string | null = null;
    const phoneMatch = text.match(/1[3-9]\d{9}/);
    if (phoneMatch) {
      const hit = await this.prisma.aliasEntry.findUnique({ where: { tenantId_kind_key: { tenantId: user.tenantId, kind: 'CUSTOMER', key: phoneMatch[0] } } });
      if (hit) customerId = hit.targetId;
      else {
        const byPhone = await this.prisma.customer.findFirst({ where: { phone: phoneMatch[0] } });
        if (byPhone) customerId = byPhone.id;
      }
    }
    if (!customerId) {
      const hint = items.length ? null : null;
      void hint;
      const customers = await this.prisma.customer.findMany({ where: { status: 'ACTIVE' }, select: { id: true, name: true } });
      const textNorm = text.toLowerCase();
      const byName = customers.find((c) => textNorm.includes(c.name) || c.name.includes(text.slice(0, 4)));
      if (byName) customerId = byName.id;
    }
    return { items: out, customerId };
  }

  /** 人工编辑草稿(可编辑红线): 覆盖 items/customerId */
  async update(user: AuthUser, id: string, dto: { customerId?: string; items?: DraftItem[] }): Promise<unknown> {
    const d = await this.prisma.orderDraft.findUnique({ where: { id } });
    if (!d) throw new NotFoundException('草稿不存在');
    if (user.role === 'REP' && d.createdById !== user.id) throw new ForbiddenException('无权编辑他人草稿');
    if (d.status !== 'PENDING_REVIEW') throw new ConflictException(`仅待确认草稿可编辑(当前 ${d.status})`);
    const updated = await this.prisma.orderDraft.update({
      where: { id },
      data: {
        customerId: dto.customerId,
        items: (dto.items ?? (d.items as unknown as DraftItem[])) as never,
      },
    });
    await this.audit.log({ user, action: 'DRAFT_UPDATE', entityType: 'OrderDraft', entityId: id, after: { items: dto.items?.length } });
    return updated;
  }

  /** 确认转单: 创建 PENDING_CONFIRM 订单(红线: 不直接出库) + 别名自动学习 */
  async confirm(user: AuthUser, id: string, dto: { customerId?: string; lines?: Array<{ productId: string; qty: number; unit: 'BASE' | 'MIN'; priceOverride?: number }>; learnAliases?: boolean }): Promise<unknown> {
    const d = await this.prisma.orderDraft.findUnique({ where: { id } });
    if (!d) throw new NotFoundException('草稿不存在');
    if (user.role === 'REP' && d.createdById !== user.id) throw new ForbiddenException('无权转单他人草稿');
    if (d.status !== 'PENDING_REVIEW') throw new ConflictException(`仅待确认草稿可转单(当前 ${d.status})`);
    const draftItems = (d.items as unknown as DraftItem[]) ?? [];
    const customerId = dto.customerId ?? d.customerId;
    if (!customerId) throw new BadRequestException('请先选定客户');
    const lines = (dto.lines?.length
      ? dto.lines
      : draftItems.filter((i) => i.productId).map((i) => ({ productId: i.productId!, qty: Number(i.qty), unit: (i.unit === '瓶' || i.unit === '个' ? 'MIN' : 'BASE') as 'BASE' | 'MIN', priceOverride: i.unitPrice ?? undefined })));
    if (!lines.length) throw new BadRequestException('无可转单行(请先为商品行匹配商品)');
    const order = await this.orders.create(
      { customerId, source: user.role === 'REP' ? 'REP' : 'CLERK', lines, note: `草稿转单 ${d.draftNo}${d.source === 'VOICE' ? '(语音)' : d.source === 'PHOTO' ? '(拍照)' : ''}` },
      user,
    );
    await this.prisma.orderDraft.update({ where: { id }, data: { status: 'CONFIRMED', customerId, convertedOrderId: (order as { id: string }).id } });
    // 别名学习(AUTO_LEARNED): 草稿原名 ≠ 标准商品名 的映射回写词典
    if (dto.learnAliases !== false) {
      const prodIds = new Set(lines.map((l) => l.productId));
      for (const item of draftItems) {
        if (!item.productId || !prodIds.has(item.productId)) continue;
        const product = await this.prisma.product.findUnique({ where: { id: item.productId }, select: { name: true } });
        if (!product || product.name === item.productName) continue;
        const key = item.productName.trim().toLowerCase();
        if (key.length < 2) continue;
        await this.prisma.aliasEntry.upsert({
          where: { tenantId_kind_key: { tenantId: user.tenantId, kind: 'PRODUCT', key } },
          update: { targetId: item.productId, hitCount: { increment: 1 } },
          create: { tenantId: user.tenantId, kind: 'PRODUCT', key, targetId: item.productId, source: 'AUTO_LEARNED', createdById: user.id },
        }).catch(() => undefined);
      }
      // 电话→客户学习
      const phone = d.rawText?.match(/1[3-9]\d{9}/)?.[0];
      if (phone) {
        await this.prisma.aliasEntry.upsert({
          where: { tenantId_kind_key: { tenantId: user.tenantId, kind: 'CUSTOMER', key: phone } },
          update: { targetId: customerId, hitCount: { increment: 1 } },
          create: { tenantId: user.tenantId, kind: 'CUSTOMER', key: phone, targetId: customerId, source: 'AUTO_LEARNED', createdById: user.id },
        }).catch(() => undefined);
      }
    }
    await this.audit.log({ user, action: 'DRAFT_CONFIRM', entityType: 'OrderDraft', entityId: id, after: { draftNo: d.draftNo, orderNo: (order as { orderNo: string }).orderNo, lines: lines.length } });
    return { draftNo: d.draftNo, orderId: (order as { id: string }).id, orderNo: (order as { orderNo: string }).orderNo, orderStatus: (order as { status: string }).status };
  }

  async discard(user: AuthUser, id: string): Promise<unknown> {
    const d = await this.prisma.orderDraft.findUnique({ where: { id } });
    if (!d) throw new NotFoundException('草稿不存在');
    if (user.role === 'REP' && d.createdById !== user.id) throw new ForbiddenException('无权废弃他人草稿');
    if (d.status !== 'PENDING_REVIEW') throw new ConflictException('已转单草稿不可废弃');
    await this.prisma.orderDraft.update({ where: { id }, data: { status: 'DISCARDED' } });
    await this.audit.log({ user, action: 'DRAFT_DISCARD', entityType: 'OrderDraft', entityId: id });
    return { id, status: 'DISCARDED' };
  }

  async list(user: AuthUser, q: { status?: string; page?: number; pageSize?: number }): Promise<unknown> {
    const page = Math.max(1, q.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, q.pageSize ?? 20));
    // P1 行级归属: REP 只看自己的草稿(原 void user; 全租户横向可见他人草稿+客户报货明细)
    const where: Prisma.OrderDraftWhereInput = {
      status: q.status as never,
      ...(user.role === 'REP' ? { createdById: user.id } : {}),
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.orderDraft.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize }),
      this.prisma.orderDraft.count({ where }),
    ]);
    return { items: items.map((d) => ({ ...d, lowConfidence: d.confidence < LOW_CONFIDENCE })), total };
  }

  async detail(user: AuthUser, id: string): Promise<unknown> {
    const d = await this.prisma.orderDraft.findUnique({ where: { id } });
    if (!d) throw new NotFoundException('草稿不存在');
    // P1 行级归属: REP 只能读自己的草稿(同租户横向越权收口)
    if (user.role === 'REP' && d.createdById !== user.id) throw new ForbiddenException('无权查看他人草稿');
    return { ...d, lowConfidence: d.confidence < LOW_CONFIDENCE };
  }

  /** 引擎健康(部署检查用) */
  async engineStatus(): Promise<unknown> {
    const ok = await this.engine.available();
    return { engine: 'qwen3.8-27b', available: ok, baseUrl: process.env.QWEN_BASE_URL || 'http://127.0.0.1:18020/v1' };
  }

  /** 别词典管理 */
  async aliases(q: { kind?: 'PRODUCT' | 'CUSTOMER' }): Promise<unknown> {
    return this.prisma.aliasEntry.findMany({ where: { kind: q.kind }, orderBy: { hitCount: 'desc' }, take: 200 });
  }

  async addAlias(user: AuthUser, dto: { kind: 'PRODUCT' | 'CUSTOMER'; key: string; targetId: string }): Promise<unknown> {
    const key = dto.key.trim().toLowerCase();
    if (key.length < 2) throw new BadRequestException('别名过短');
    return this.prisma.aliasEntry.upsert({
      where: { tenantId_kind_key: { tenantId: user.tenantId, kind: dto.kind, key } },
      update: { targetId: dto.targetId, source: 'MANUAL' },
      create: { tenantId: user.tenantId, kind: dto.kind, key, targetId: dto.targetId, source: 'MANUAL', createdById: user.id },
    });
  }

  async removeAlias(user: AuthUser, id: string): Promise<unknown> {
    await this.prisma.aliasEntry.deleteMany({ where: { id } });
    void user;
    return { ok: true };
  }
}
