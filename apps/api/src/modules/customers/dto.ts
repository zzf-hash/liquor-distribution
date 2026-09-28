// P0-T12 客户档案 DTO：开户四步 F1 业务员录入→内勤确认→老板终审
import { IsEnum, IsIn, IsInt, IsNumber, IsOptional, IsString, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { CustomerType, OnboardingStatus, SettlementType, SignMode } from '@prisma/client';

export class ListCustomersDto {
  /** 编码/店名/手机号 模糊 */
  @IsOptional()
  @IsString()
  q?: string;

  @IsOptional()
  @IsEnum(CustomerType)
  type?: CustomerType;

  @IsOptional()
  @IsEnum(SettlementType)
  settlement?: SettlementType;

  @IsOptional()
  @IsEnum(OnboardingStatus)
  onboarding?: OnboardingStatus;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  pageSize?: number;
}

export class CreateCustomerDto {
  /** 客户编码，租户内唯一 */
  @IsString()
  code!: string;

  @IsString()
  name!: string;

  @IsEnum(CustomerType)
  type!: CustomerType;

  @IsOptional()
  @IsString()
  contact?: string;

  @IsString()
  phone!: string;

  @IsOptional()
  @IsString()
  region?: string;

  @IsString()
  address!: string;

  /** A/B/C */
  @IsOptional()
  @IsString()
  abcLevel?: string;

  /** 现结=款到发货；月结必须 termsDays>0（service 校验） */
  @IsEnum(SettlementType)
  settlement!: SettlementType;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  termsDays?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  creditLimit?: number;

  /** 起送量 */
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  minOrderAmount?: number;

  /** 收货时段 */
  @IsOptional()
  @IsString()
  receivingWindow?: string;

  @IsOptional()
  @IsEnum(SignMode)
  signMode?: SignMode;

  @IsOptional()
  @IsString()
  printerModel?: string;

  /** 归属业务员（绩效锚 D5）；REP 自建缺省挂自己 */
  @IsOptional()
  @IsString()
  salespersonId?: string;

  @IsOptional()
  @IsString()
  bossPhone?: string;

  @IsOptional()
  @IsString()
  licenseNo?: string;

  @IsOptional()
  @IsString()
  note?: string;
}

// 改档只允许非编码字段：code 是应收/订单/专属价的锚点，禁改
export class UpdateCustomerDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsEnum(CustomerType)
  type?: CustomerType;

  @IsOptional()
  @IsString()
  contact?: string;

  @IsOptional()
  @IsString()
  phone?: string;

  @IsOptional()
  @IsString()
  region?: string;

  @IsOptional()
  @IsString()
  address?: string;

  @IsOptional()
  @IsString()
  abcLevel?: string;

  @IsOptional()
  @IsEnum(SettlementType)
  settlement?: SettlementType;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  termsDays?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  creditLimit?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  minOrderAmount?: number;

  @IsOptional()
  @IsString()
  receivingWindow?: string;

  @IsOptional()
  @IsEnum(SignMode)
  signMode?: SignMode;

  @IsOptional()
  @IsString()
  printerModel?: string;

  @IsOptional()
  @IsString()
  salespersonId?: string;

  @IsOptional()
  @IsString()
  bossPhone?: string;

  @IsOptional()
  @IsString()
  licenseNo?: string;

  @IsOptional()
  @IsString()
  note?: string;
}

export type OnboardingAction = 'clerk_confirm' | 'submit_owner' | 'owner_approve' | 'reject';

export class OnboardingActionDto {
  @IsIn(['clerk_confirm', 'submit_owner', 'owner_approve', 'reject'])
  action!: OnboardingAction;

  /** 驳回/放行理由，审计留痕 */
  @IsOptional()
  @IsString()
  reason?: string;
}
