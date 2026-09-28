import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import dayjs from 'dayjs';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../../audit/audit.service';
import type { AuthUser } from '../../common/current-user.decorator';

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
    return { id: record.id };
  }

  /** 24h 超时退回(D01: 不自动通过); 惰性扫描——列表/详情访问时触发(无 cron 依赖) */
  async expireStale(user: AuthUser): Promise<number> {
    const cutoff = dayjs().subtract(24, 'hour').toDate();
    const stale = await this.prisma.approvalRecord.findMany({
      where: { status: 'PENDING', createdAt: { lt: cutoff } },
      select: { id: true, entityType: true, entityId: true },
    });
    if (stale.length === 0) return 0;
    await this.prisma.$transaction(async (tx) => {
      await tx.approvalRecord.updateMany({ where: { id: { in: stale.map((s) => s.id) } }, data: { status: 'EXPIRED_24H', decidedAt: new Date() } });
      // 联动退回: 特单 PENDING_PRICE → DRAFT
      for (const s of stale) {
        if (s.entityType === 'SPECIAL_ORDER') {
          await tx.specialOrder.updateMany({ where: { id: s.entityId, status: 'PENDING_PRICE' }, data: { status: 'DRAFT' } });
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
    const [items, total] = await this.prisma.$transaction([
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
    const threshold = await this.threshold();
    const amount = record.amount !== null ? Number(record.amount) : null;
    // 路由硬闸: 老板专属线 或 金额超阈值 → 仅 OWNER; 其余 CLERK/OWNER 均可
    const ownerOnly = OWNER_ONLY_LINES.has(record.line) || (amount !== null && amount > threshold);
    if (ownerOnly && user.role !== 'OWNER') {
      throw new ForbiddenException(ownerOnly && amount !== null && amount > threshold && !OWNER_ONLY_LINES.has(record.line)
        ? `金额 ¥${amount} 超阈值 ¥${threshold}, 须老板审批` : '该审批线仅老板可批');
    }
    const approved = dto.action === 'approve';
    await this.prisma.$transaction(async (tx) => {
      await tx.approvalRecord.update({ where: { id }, data: { status: approved ? 'APPROVED' : 'REJECTED', approverId: user.id, decidedAt: new Date() } });
      await this.applySideEffects(tx, user, record, approved);
    });
    await this.audit.log({ user, action: 'APPROVAL_DECIDE', entityType: 'ApprovalRecord', entityId: id, before: { status: 'PENDING' }, after: { status: approved ? 'APPROVED' : 'REJECTED', line: record.line, entityId: record.entityId, opinion: dto.opinion }, ip });
    return { id, approved, line: record.line, entityType: record.entityType, entityId: record.entityId };
  }

  /** 线内联动副作用: 审批结果回写业务单据 */
  private async applySideEffects(tx: Pick<PrismaService, 'approvalRecord' | 'specialOrder' | 'returnOrder' | 'salesOrder' | 'priceChangeRequest' | 'purchaseOrder' | 'stocktake'>, user: AuthUser, record: { line: string; entityType: string; entityId: string }, approved: boolean): Promise<void> {
    if (record.entityType === 'SPECIAL_ORDER') {
      await tx.specialOrder.update({ where: { id: record.entityId }, data: { status: approved ? 'APPROVED' : 'REJECTED' } });
    } else if (record.entityType === 'RETURN') {
      await tx.returnOrder.update({ where: { id: record.entityId }, data: { status: approved ? 'APPROVED' : 'CANCELLED' } });
    } else if (record.entityType === 'ORDER' && record.line === 'CREDIT_RELEASE' && approved) {
      await tx.salesOrder.update({ where: { id: record.entityId }, data: { specialApproved: true } });
    } else if (record.entityType === 'PRICE_CHANGE') {
      await tx.priceChangeRequest.update({ where: { id: record.entityId }, data: { status: approved ? 'APPROVED' : 'REJECTED' } });
    } else if (record.entityType === 'PURCHASE') {
      await tx.purchaseOrder.update({ where: { id: record.entityId }, data: { status: approved ? 'APPROVED' : 'CANCELLED' } });
    } else if (record.entityType === 'STOCKTAKE') {
      // 盘点差异: 批准→RECONCILED(可调账); 驳回→COUNTED(重盘)
      await tx.stocktake.update({ where: { id: record.entityId }, data: { status: approved ? 'RECONCILED' : 'COUNTED' } });
    }
    void user;
  }
}
