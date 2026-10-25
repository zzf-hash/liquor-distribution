import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import dayjs from 'dayjs';
import { PrismaService } from '../../prisma/prisma.service';
import { sequential } from '../../prisma/relation-read';
import { AuditService } from '../../audit/audit.service';
import { NotifyService } from '../../common/notify.service';
import type { AuthUser } from '../../common/current-user.decorator';
import { requirePriceUnit } from '../../common/require-price-unit';

// ═══════════════ P1-T01 审批中心: 五条线统一 ═══════════════
// D01 冻结口径: 单笔 ≤ 阈值(默认2000, cfg special_approve_threshold)内勤可批;
//   > 阈值或低于成本价 → 老板; 审批超时 24h → 退回(EXPIRED_24H), 不自动通过
// 线内规则: 信用放行(R2)/退货(D13)恒为老板; 特单价格/调价/采购/运营费按金额路由
// 审批人唯一, 系统按金额自动路由, 不允许自选审批人(D01)

const OWNER_ONLY_LINES = new Set(['CREDIT_RELEASE', 'RETURN']); // R2 资金命门 / D13 老板审批

@Injectable()
export class ApprovalsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notify: NotifyService,
  ) {}

  private async threshold(): Promise<number> {
    const row = await this.prisma.systemConfig.findFirst({ where: { key: 'special_approve_threshold' } });
    const v = row ? Number((row.value as { v?: unknown })?.v ?? row.value) : NaN;
    return Number.isFinite(v) ? v : 2000;
  }

  /** 发起审批(内部 API): 金额路由落 approverHint, 超时由 expire 扫描处理 */
  async create(user: AuthUser, input: {
    line: 'CREDIT_RELEASE' | 'PRICE_SPECIAL' | 'PRICE_CHANGE' | 'PURCHASE' | 'EXPENSE' | 'RETURN' | 'STOCKTAKE';
    entityType: string; entityId: string; title: string;
    amount?: number; reason: string; payload?: Record<string, unknown>;
  }): Promise<{ id: string }> {
    if (!input.reason?.trim()) throw new BadRequestException('审批申请必须填写理由');
    const record = await this.prisma.approvalRecord.create({
      data: {
        tenantId: user.tenantId, line: input.line, entityType: input.entityType, entityId: input.entityId,
        title: input.title, amount: input.amount !== undefined ? new Prisma.Decimal(input.amount) : undefined,
        reason: input.reason, payload: (input.payload ?? undefined) as never,
        applicantId: user.id, status: 'PENDING',
      },
    });
    await this.audit.log({ user, action: 'APPROVAL_CREATE', entityType: input.entityType, entityId: input.entityId, after: { approvalId: record.id, line: input.line, amount: input.amount } });
    const fields: Array<[string, string]> = [
      ['单据', input.title],
      ['金额', input.amount !== undefined ? `¥${input.amount}` : '—'],
      ['线别', input.line],
      ['申请人', user.name],
    ];
    let cardSent = false;
    try { cardSent = await this.notify.sendApprovalCard(input.title, fields, '点击进入后台「审批中心」处理'); } catch { cardSent = false; }
    if (!cardSent) void this.notify.send('审批待办', [...fields.map(([k, v]) => `${k}: ${v}`), '请到后台「审批中心」处理']);
    return { id: record.id };
  }

  /** 24h 超时退回(D01: 不自动通过); 惰性扫描——列表/详情访问时触发(无 cron 依赖)
   * #12: 采购/调价/盘点超期原不联动退回, 单据停在 PENDING_APPROVAL/PENDING 成永久死单 */
  async expireStale(user: AuthUser): Promise<number> {
    const cutoff = dayjs().subtract(24, 'hour').toDate();
    const stale = await this.prisma.approvalRecord.findMany({
      where: { status: 'PENDING', createdAt: { lt: cutoff } },
      select: { id: true, entityType: true, entityId: true },
    });
    if (stale.length === 0) return 0;
    await this.prisma.$transaction(async (tx) => {
      await tx.approvalRecord.updateMany({ where: { id: { in: stale.map((s) => s.id) } }, data: { status: 'EXPIRED_24H', decidedAt: new Date() } });
      // 联动退回: 单据回到可编辑/可重新提审状态
      for (const s of stale) {
        if (s.entityType === 'SPECIAL_ORDER') {
          await tx.specialOrder.updateMany({ where: { id: s.entityId, status: 'PENDING_PRICE' }, data: { status: 'DRAFT' } });
        } else if (s.entityType === 'PURCHASE') {
          await tx.purchaseOrder.updateMany({ where: { id: s.entityId, status: 'PENDING_APPROVAL' }, data: { status: 'DRAFT' } });
        } else if (s.entityType === 'PRICE_CHANGE') {
          await tx.priceChangeRequest.updateMany({ where: { id: s.entityId, status: 'PENDING' }, data: { status: 'DRAFT' } });
        } else if (s.entityType === 'STOCKTAKE') {
          await tx.stocktake.updateMany({ where: { id: s.entityId, status: 'PENDING_APPROVAL' }, data: { status: 'DRAFT' } });
        } else if (s.entityType === 'RETURN') {
          await tx.returnOrder.updateMany({ where: { id: s.entityId, status: 'PENDING_REVIEW' }, data: { status: 'CANCELLED' } });
        } else if (s.entityType === 'EXPENSE') {
          // B组: 费用单超时退回→取消(金额/事由变化大, 重报比复活旧单干净)
          await tx.expense.updateMany({ where: { id: s.entityId, tenantId: user.tenantId, status: 'PENDING_APPROVAL' }, data: { status: 'CANCELLED' } });
        }
      }
    });
    await this.audit.log({ user, action: 'APPROVAL_EXPIRE', entityType: 'ApprovalRecord', after: { count: stale.length } });
    return stale.length;
  }

  async list(user: AuthUser, q: { status?: 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXPIRED_24H'; page?: number; pageSize?: number }): Promise<unknown> {
    if (q.status === 'PENDING' || q.status === undefined) await this.expireStale(user);
    const page = Math.max(1, q.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, q.pageSize ?? 20));
    const where = { status: q.status };
    const [items, total] = await sequential([
      this.prisma.approvalRecord.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { applicant: { select: { id: true, name: true, role: true } } },
      }),
      this.prisma.approvalRecord.count({ where }),
    ]);
    const threshold = await this.threshold();
    return {
      items: items.map((r) => ({
        id: r.id, line: r.line, entityType: r.entityType, entityId: r.entityId, title: r.title,
        amount: r.amount !== null ? Number(r.amount) : null, reason: r.reason, payload: r.payload,
        applicant: r.applicant ? { id: r.applicant.id, name: r.applicant.name, role: r.applicant.role } : null,
        status: r.status, createdAt: r.createdAt,
        approverHint: OWNER_ONLY_LINES.has(r.line) ? '仅老板' : r.amount !== null && Number(r.amount) > threshold ? '仅老板' : '内勤可批',
      })),
      total, threshold,
    };
  }

  /** 审批决定: 金额路由硬校验(前端提示只是提示, 权限在这里强制) */
  async decide(user: AuthUser, id: string, dto: { action: 'approve' | 'reject'; opinion: string }, ip?: string): Promise<unknown> {
    if (!dto.opinion?.trim()) throw new BadRequestException('审批意见必填');
    const record = await this.prisma.approvalRecord.findUnique({ where: { id } });
    if (!record) throw new NotFoundException('审批单不存在');
    if (record.status !== 'PENDING') throw new ConflictException(`该审批已处理(${record.status})`);
    // #13: 绕过列表直接 decide 可批过期数天的审批——先惰性跑一遍过期扫描
    await this.expireStale(user);
    const fresh = await this.prisma.approvalRecord.findUnique({ where: { id }, select: { status: true } });
    if (!fresh || fresh.status !== 'PENDING') {
      throw new ConflictException(`该审批已超时过期(${fresh?.status ?? 'UNKNOWN'}), 请让申请人重新提审`);
    }
    // 申请人回避(2026-10 审查修复): ≤阈值时 CLERK 可批, 原实现连自己提审的单也能批, 制衡失效
    if (record.applicantId === user.id) throw new ForbiddenException('不可审批自己发起的申请');
    const threshold = await this.threshold();
    const amount = record.amount !== null ? Number(record.amount) : null;
    // 路由硬闸: 老板专属线 或 金额超阈值 → 仅 OWNER; 其余 CLERK/OWNER 均可
    let belowCost = false;
    if (record.entityType === 'SPECIAL_ORDER' && record.line === 'PRICE_SPECIAL') {
      const special = await this.prisma.specialOrder.findUnique({ where: { id: record.entityId }, include: { lines: true } });
      for (const line of special?.lines ?? []) {
        if (!line.productId) continue;
        const unit = requirePriceUnit(line.unit);
        const cost = await this.prisma.price.findFirst({
          where: { productId: line.productId, unit, levelType: 'COST', validFrom: { lte: new Date() }, OR: [{ validTo: null }, { validTo: { gte: new Date() } }] },
          orderBy: { validFrom: 'desc' },
        });
        if (cost && Number(line.price) < Number(cost.price)) { belowCost = true; break; }
      }
    }
    const ownerOnly = OWNER_ONLY_LINES.has(record.line) || (amount !== null && amount > threshold) || belowCost;
    if (ownerOnly && user.role !== 'OWNER') {
      throw new ForbiddenException(ownerOnly && amount !== null && amount > threshold && !OWNER_ONLY_LINES.has(record.line)
        ? `金额 ¥${amount} 超阈值 ¥${threshold}, 须老板审批` : '该审批线仅老板可批');
    }
    const approved = dto.action === 'approve';
    await this.prisma.$transaction(async (tx) => {
      // 实体状态闸(2026-10 审查修复): 关联单据已流转(取消/收货/过期退回)时拒绝决策,
      // 防"审批复活已取消单据"(如取消退货后老板补批→单据被改回 APPROVED→照常回冲)
      await this.assertEntityDecidable(tx, record);
      // 条件更新抢占: 并发双批(批+驳各执行一次)在此互斥
      const claimed = await tx.approvalRecord.updateMany({
        where: { id, status: 'PENDING' },
        data: { status: approved ? 'APPROVED' : 'REJECTED', approverId: user.id, decidedAt: new Date() },
      });
      if (claimed.count === 0) throw new ConflictException('该审批已处理');
      await this.applySideEffects(tx, user, record, approved, dto.opinion);
    });
    await this.audit.log({ user, action: 'APPROVAL_DECIDE', entityType: 'ApprovalRecord', entityId: id, before: { status: 'PENDING' }, after: { status: approved ? 'APPROVED' : 'REJECTED', line: record.line, entityId: record.entityId, opinion: dto.opinion }, ip });
    return { id, approved, line: record.line, entityType: record.entityType, entityId: record.entityId };
  }

  /** 各审批线实体进入"可决策"状态的前置值; 已流转则 409(不静默吞) */
  private async assertEntityDecidable(tx: Pick<PrismaService, 'specialOrder' | 'returnOrder' | 'salesOrder' | 'priceChangeRequest' | 'purchaseOrder' | 'stocktake' | 'expense'>, record: { entityType: string; entityId: string; tenantId: string }): Promise<void> {
    const expect: Record<string, string[]> = {
      SPECIAL_ORDER: ['PENDING_PRICE'],
      RETURN: ['PENDING_REVIEW'],
      PURCHASE: ['PENDING_APPROVAL', 'RECEIVED_PENDING_APPROVAL'],
      PRICE_CHANGE: ['PENDING'],
      STOCKTAKE: ['PENDING_APPROVAL'],
      ORDER: ['PENDING_CONFIRM', 'CONFIRMED'],
      EXPENSE: ['PENDING_APPROVAL'],
    };
    const allowed = expect[record.entityType];
    if (!allowed) return;
    let status: string | undefined;
    if (record.entityType === 'SPECIAL_ORDER') status = (await tx.specialOrder.findUnique({ where: { id: record.entityId }, select: { status: true } }))?.status;
    else if (record.entityType === 'RETURN') status = (await tx.returnOrder.findUnique({ where: { id: record.entityId }, select: { status: true } }))?.status;
    else if (record.entityType === 'ORDER') status = (await tx.salesOrder.findUnique({ where: { id: record.entityId }, select: { status: true } }))?.status;
    else if (record.entityType === 'PRICE_CHANGE') status = (await tx.priceChangeRequest.findUnique({ where: { id: record.entityId }, select: { status: true } }))?.status;
    else if (record.entityType === 'PURCHASE') status = (await tx.purchaseOrder.findUnique({ where: { id: record.entityId }, select: { status: true } }))?.status;
    else if (record.entityType === 'STOCKTAKE') status = (await tx.stocktake.findUnique({ where: { id: record.entityId }, select: { status: true } }))?.status;
    else if (record.entityType === 'EXPENSE') status = (await tx.expense.findUnique({ where: { id: record.entityId, tenantId: record.tenantId }, select: { status: true } }))?.status;
    if (!status || !allowed.includes(status)) {
      throw new ConflictException(`关联单据状态已变化(${status ?? '不存在'}), 该审批不再可决策, 请在业务侧处理`);
    }
  }

  /** 线内联动副作用: 审批结果回写业务单据(条件更新——实体状态已变则整体回滚) */
  private async applySideEffects(tx: Pick<PrismaService, 'approvalRecord' | 'specialOrder' | 'returnOrder' | 'salesOrder' | 'priceChangeRequest' | 'purchaseOrder' | 'stocktake' | 'restockRequest' | 'dailyStockReport' | 'expense'>, user: AuthUser, record: { line: string; entityType: string; entityId: string; tenantId: string }, approved: boolean, opinion?: string): Promise<void> {
    if (record.entityType === 'SPECIAL_ORDER') {
      const u = await tx.specialOrder.updateMany({ where: { id: record.entityId, status: 'PENDING_PRICE' }, data: { status: approved ? 'APPROVED' : 'REJECTED' } });
      if (u.count === 0) throw new ConflictException('特单状态已变化, 审批副作用未执行');
    } else if (record.entityType === 'RETURN') {
      const u = await tx.returnOrder.updateMany({ where: { id: record.entityId, status: 'PENDING_REVIEW' }, data: { status: approved ? 'APPROVED' : 'CANCELLED' } });
      if (u.count === 0) throw new ConflictException('退货单状态已变化, 审批副作用未执行');
    } else if (record.entityType === 'ORDER' && record.line === 'CREDIT_RELEASE' && approved) {
      // 仅待确认/已确认订单可放行(已签收/已取消订单放行无意义且属状态倒转)
      const u = await tx.salesOrder.updateMany({ where: { id: record.entityId, status: { in: ['PENDING_CONFIRM', 'CONFIRMED'] } }, data: { specialApproved: true } });
      if (u.count === 0) throw new ConflictException('订单状态已变化, 信用放行未执行');
    } else if (record.entityType === 'PRICE_CHANGE') {
      const u = await tx.priceChangeRequest.updateMany({ where: { id: record.entityId, status: 'PENDING' }, data: { status: approved ? 'APPROVED' : 'REJECTED' } });
      if (u.count === 0) throw new ConflictException('调价单状态已变化, 审批副作用未执行');
    } else if (record.entityType === 'PURCHASE') {
      const purchase = await tx.purchaseOrder.findUnique({ where: { id: record.entityId }, select: { status: true } });
      const from = purchase?.status;
      if (from !== 'PENDING_APPROVAL' && from !== 'RECEIVED_PENDING_APPROVAL') throw new ConflictException('采购单状态已变化, 审批副作用未执行');
      const to = from === 'RECEIVED_PENDING_APPROVAL' ? (approved ? 'RECEIVED' : 'RECEIVED_PENDING_APPROVAL') : (approved ? 'APPROVED' : 'DRAFT');
      const u = await tx.purchaseOrder.updateMany({ where: { id: record.entityId, status: from }, data: { status: to } });
      if (u.count === 0) throw new ConflictException('采购单状态已变化, 审批副作用未执行');
      // 自动报货单回链: 审批结果同步 RestockRequest(pending→SUBMITTED→APPROVED/DISMISSED); snapshot.autoRestock 标记
      const pur = await tx.purchaseOrder.findUnique({ where: { id: record.entityId }, select: { note: true } });
      if (pur?.note?.includes('自动报货 RQ')) {
        const reqId = pur.note.match(/RQ\d{8}-\d{4}/)?.[0];
        if (reqId) {
          const rr = await tx.restockRequest.findFirst({ where: { tenantId: record.tenantId, requestId: reqId }, select: { id: true } });
          if (rr) {
            await tx.restockRequest.update({ where: { id: rr.id }, data: { status: approved ? 'APPROVED' : 'DISMISSED', dismissedBy: approved ? null : user.id, dismissReason: approved ? null : `审批驳回: ${opinion ?? ''}` } });
            await tx.dailyStockReport.updateMany({ where: { restockId: rr.id }, data: { restockStatus: approved ? 'DONE' : 'DISMISSED' } });
          }
        }
      }
    } else if (record.entityType === 'STOCKTAKE') {
      // 盘点差异: 批准 PENDING_APPROVAL→RECONCILED(可调账); 驳回 PENDING_APPROVAL→COUNTED(重盘)
      const u = await tx.stocktake.updateMany({ where: { id: record.entityId, status: 'PENDING_APPROVAL' }, data: { status: approved ? 'RECONCILED' : 'COUNTED' } });
      if (u.count === 0) throw new ConflictException('盘点单状态已变化, 审批副作用未执行');
    } else if (record.entityType === 'EXPENSE') {
      // B组费用: 批准→APPROVED(待付款/冲抵); 驳回→REJECTED
      const u = await tx.expense.updateMany({ where: { id: record.entityId, tenantId: record.tenantId, status: 'PENDING_APPROVAL' }, data: { status: approved ? 'APPROVED' : 'REJECTED' } });
      if (u.count === 0) throw new ConflictException('费用单状态已变化, 审批副作用未执行');
    }
  }
}
