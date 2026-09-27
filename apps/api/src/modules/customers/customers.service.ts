// P0-T12 客户档案 + 开户四步状态机（F1）：
//   REP_DRAFT →(clerk_confirm·CLERK)→ CLERK_CONFIRMED →(submit_owner·CLERK)→ PENDING_OWNER
//   →(owner_approve·OWNER)→ ACTIVE ／ 非终态 →(reject·CLERK/OWNER)→ REJECTED
// 终审通过（ACTIVE）前客户不可自主下单（下单预检 T21 拦截）
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  Customer,
  CustomerStatus,
  OnboardingStatus,
  Prisma,
  SettlementType,
  SignMode,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditAction, AuditService } from '../../audit/audit.service';
import type { AuthUser } from '../../common/current-user.decorator';
import {
  CreateCustomerDto,
  ListCustomersDto,
  OnboardingAction,
  OnboardingActionDto,
  UpdateCustomerDto,
} from './dto';

const ONBOARDING_TRANSITIONS: Record<
  OnboardingAction,
  { from: OnboardingStatus[]; to: OnboardingStatus; roles: string[] }
> = {
  clerk_confirm: {
    from: [OnboardingStatus.REP_DRAFT],
    to: OnboardingStatus.CLERK_CONFIRMED,
    roles: ['CLERK'],
  },
  submit_owner: {
    from: [OnboardingStatus.CLERK_CONFIRMED],
    to: OnboardingStatus.PENDING_OWNER,
    roles: ['CLERK'],
  },
  owner_approve: {
    from: [OnboardingStatus.PENDING_OWNER],
    to: OnboardingStatus.ACTIVE,
    roles: ['OWNER'],
  },
  reject: {
    from: [OnboardingStatus.REP_DRAFT, OnboardingStatus.CLERK_CONFIRMED, OnboardingStatus.PENDING_OWNER],
    to: OnboardingStatus.REJECTED,
    roles: ['CLERK', 'OWNER'],
  },
};

@Injectable()
export class CustomersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(
    user: AuthUser,
    query: ListCustomersDto,
  ): Promise<{ items: CustomerRow[]; total: number }> {
    const where: Prisma.CustomerWhereInput = { tenantId: user.tenantId };
    const q = query.q?.trim();
    if (q) {
      where.OR = [
        { code: { contains: q, mode: 'insensitive' } },
        { name: { contains: q, mode: 'insensitive' } },
        { phone: { contains: q } },
      ];
    }
    if (query.type) where.type = query.type;
    if (query.settlement) where.settlement = query.settlement;
    if (query.onboarding) where.onboarding = query.onboarding;
    // 业务员数据范围 OWN_CUSTOMERS（D5 绩效锚）：只看自己名下客户
    if (String(user.role) === 'REP') where.salespersonId = user.id;

    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.customer.count({ where }),
      this.prisma.customer.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { salesperson: { select: { id: true, name: true } } },
      }),
    ]);
    return { items: rows.map((r) => this.toRow(r)), total };
  }

  async create(user: AuthUser, dto: CreateCustomerDto): Promise<Customer> {
    if (
      dto.settlement === SettlementType.MONTHLY &&
      !(typeof dto.termsDays === 'number' && dto.termsDays > 0)
    ) {
      throw new BadRequestException('月结客户必须填写账期天数（>0）');
    }
    const dup = await this.prisma.customer.findFirst({
      where: { tenantId: user.tenantId, code: dto.code },
      select: { id: true },
    });
    if (dup) throw new ConflictException(`客户编码「${dto.code}」已存在（租户内唯一）`);

    // 业务员自建默认挂自己；显式指定则校验同租户存在
    const salespersonId =
      dto.salespersonId ?? (String(user.role) === 'REP' ? user.id : undefined);
    if (salespersonId) {
      const rep = await this.prisma.user.findFirst({
        where: { id: salespersonId, tenantId: user.tenantId },
        select: { id: true },
      });
      if (!rep) throw new BadRequestException('归属业务员不存在');
    }

    // 新增客户一律走系统开户流程，不可绕过四步（M0 冻结项 10）
    return this.prisma.customer.create({
      data: {
        tenantId: user.tenantId,
        code: dto.code,
        name: dto.name,
        type: dto.type,
        contact: dto.contact,
        phone: dto.phone,
        region: dto.region,
        address: dto.address,
        abcLevel: dto.abcLevel,
        settlement: dto.settlement,
        termsDays:
          dto.settlement === SettlementType.MONTHLY ? (dto.termsDays ?? 30) : (dto.termsDays ?? 0),
        creditLimit: new Prisma.Decimal(dto.creditLimit ?? 0),
        minOrderAmount: new Prisma.Decimal(dto.minOrderAmount ?? 0),
        receivingWindow: dto.receivingWindow,
        signMode: dto.signMode ?? SignMode.E_SIGN,
        printerModel: dto.printerModel,
        salespersonId,
        bossPhone: dto.bossPhone,
        licenseNo: dto.licenseNo,
        note: dto.note,
        onboarding: OnboardingStatus.REP_DRAFT,
      },
    });
  }

  async detail(user: AuthUser, id: string) {
    const row = await this.prisma.customer.findFirst({
      where: { id, tenantId: user.tenantId },
      include: {
        salesperson: { select: { id: true, name: true } },
        _count: { select: { prices: true } },
      },
    });
    if (!row) throw new NotFoundException('客户不存在');
    const { _count, ...customer } = row;
    return { ...customer, priceCount: _count.prices };
  }

  async update(user: AuthUser, id: string, dto: UpdateCustomerDto, ip?: string): Promise<Customer> {
    const before = await this.prisma.customer.findFirst({
      where: { id, tenantId: user.tenantId },
    });
    if (!before) throw new NotFoundException('客户不存在');

    // 月结口径：无论改结算方式还是账期，落库后的组合必须满足 月结→termsDays>0
    const settlement = dto.settlement ?? before.settlement;
    const termsDays = dto.termsDays ?? before.termsDays;
    if (settlement === SettlementType.MONTHLY && !(termsDays > 0)) {
      throw new BadRequestException('月结客户账期天数必须 >0');
    }
    if (dto.salespersonId) {
      const rep = await this.prisma.user.findFirst({
        where: { id: dto.salespersonId, tenantId: user.tenantId },
        select: { id: true },
      });
      if (!rep) throw new BadRequestException('归属业务员不存在');
    }

    const data: Prisma.CustomerUncheckedUpdateInput = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.type !== undefined) data.type = dto.type;
    if (dto.contact !== undefined) data.contact = dto.contact;
    if (dto.phone !== undefined) data.phone = dto.phone;
    if (dto.region !== undefined) data.region = dto.region;
    if (dto.address !== undefined) data.address = dto.address;
    if (dto.abcLevel !== undefined) data.abcLevel = dto.abcLevel;
    if (dto.settlement !== undefined) data.settlement = dto.settlement;
    if (dto.termsDays !== undefined) data.termsDays = dto.termsDays;
    if (dto.creditLimit !== undefined) data.creditLimit = new Prisma.Decimal(dto.creditLimit);
    if (dto.minOrderAmount !== undefined) data.minOrderAmount = new Prisma.Decimal(dto.minOrderAmount);
    if (dto.receivingWindow !== undefined) data.receivingWindow = dto.receivingWindow;
    if (dto.signMode !== undefined) data.signMode = dto.signMode;
    if (dto.printerModel !== undefined) data.printerModel = dto.printerModel;
    if (dto.salespersonId !== undefined) data.salespersonId = dto.salespersonId;
    if (dto.bossPhone !== undefined) data.bossPhone = dto.bossPhone;
    if (dto.licenseNo !== undefined) data.licenseNo = dto.licenseNo;
    if (dto.note !== undefined) data.note = dto.note;

    const after = await this.prisma.customer.update({ where: { id }, data });

    // 信用/账期/归属业务员是风控与绩效锚点，改动必写审计（P0-T03）
    const auditWorthy =
      (dto.creditLimit !== undefined &&
        before.creditLimit.toString() !== new Prisma.Decimal(dto.creditLimit).toString()) ||
      (dto.termsDays !== undefined && before.termsDays !== dto.termsDays) ||
      (dto.salespersonId !== undefined && before.salespersonId !== dto.salespersonId);
    if (auditWorthy) {
      try {
        await this.audit.log({
          user,
          action: AuditAction.MASTER_UPDATE,
          entityType: 'Customer',
          entityId: id,
          before: this.auditFields(before),
          after: this.auditFields(after),
          ip,
        });
      } catch {
        // 审计失败不阻断业务
      }
    }
    return after;
  }

  /** 开户状态机：非法转换 409，越权 403，每次转换审计 CUSTOMER_ONBOARDING */
  async onboarding(user: AuthUser, id: string, dto: OnboardingActionDto, ip?: string) {
    const rule = ONBOARDING_TRANSITIONS[dto.action];
    const customer = await this.prisma.customer.findFirst({
      where: { id, tenantId: user.tenantId },
    });
    if (!customer) throw new NotFoundException('客户不存在');

    if (!rule.from.includes(customer.onboarding)) {
      throw new ConflictException(
        `非法状态转换：${customer.onboarding} 状态下不可执行 ${dto.action}`,
      );
    }
    const role = String(user.role);
    if (!rule.roles.includes(role)) {
      throw new ForbiddenException(`角色「${role}」无权执行 ${dto.action}（需 ${rule.roles.join('/')}）`);
    }

    const after = await this.prisma.customer.update({
      where: { id },
      data: { onboarding: rule.to },
    });
    try {
      await this.audit.log({
        user,
        action: AuditAction.CUSTOMER_ONBOARDING,
        entityType: 'Customer',
        entityId: id,
        before: { onboarding: customer.onboarding },
        after: { onboarding: rule.to, action: dto.action, reason: dto.reason ?? null },
        ip,
      });
    } catch {
      // 审计失败不阻断业务
    }
    return after;
  }

  /** 禁用：禁自主下单，不禁纸单回录（D12）——仅 OWNER/CLERK */
  async disable(user: AuthUser, id: string, ip?: string): Promise<Customer> {
    if (String(user.role) !== 'OWNER' && String(user.role) !== 'CLERK') {
      throw new ForbiddenException('仅老板/内勤可禁用客户');
    }
    const before = await this.prisma.customer.findFirst({
      where: { id, tenantId: user.tenantId },
    });
    if (!before) throw new NotFoundException('客户不存在');

    const after = await this.prisma.customer.update({
      where: { id },
      data: { status: CustomerStatus.DISABLED },
    });
    try {
      await this.audit.log({
        user,
        action: AuditAction.MASTER_UPDATE,
        entityType: 'Customer',
        entityId: id,
        before: this.auditFields(before),
        after: { ...this.auditFields(after), note: '禁用：禁自主下单，纸单回录不受限（D12）' },
        ip,
      });
    } catch {
      // 审计失败不阻断业务
    }
    return after;
  }

  private toRow(r: Customer & { salesperson: { id: string; name: string } | null }): CustomerRow {
    const { salesperson, ...customer } = r;
    return { ...customer, salesperson };
  }

  /** 审计负载只取 JSON 安全字段（Decimal 转字符串） */
  private auditFields(c: Customer): Record<string, unknown> {
    return {
      code: c.code,
      name: c.name,
      settlement: c.settlement,
      termsDays: c.termsDays,
      creditLimit: c.creditLimit.toString(),
      salespersonId: c.salespersonId,
      onboarding: c.onboarding,
      status: c.status,
    };
  }
}

export type CustomerRow = Customer & { salesperson: { id: string; name: string } | null };
