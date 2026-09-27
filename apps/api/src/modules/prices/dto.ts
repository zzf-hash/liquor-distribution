// P0-T11 价格 DTO：版本化（只新增不覆盖 D08），Decimal 字段 DTO 用 number，service 转 Prisma.Decimal
import { IsDateString, IsEnum, IsNumber, IsOptional, IsString, Min } from 'class-validator';
import { PriceLevelType, PriceUnit } from '@prisma/client';

export class CreateProductPriceDto {
  /** BASE=主单位价（箱价）／MIN=最小单位价（瓶价） */
  @IsEnum(PriceUnit)
  unit!: PriceUnit;

  /** COST/TIER1/TIER2/TERMINAL/RETAIL；COST 仅 OWNER 可维护（service 校验） */
  @IsEnum(PriceLevelType)
  levelType!: PriceLevelType;

  @IsNumber()
  @Min(0)
  price!: number;

  @IsDateString()
  validFrom!: string;

  @IsOptional()
  @IsDateString()
  validTo?: string;

  /** 调价审批单号 */
  @IsOptional()
  @IsString()
  approvalRef?: string;

  @IsOptional()
  @IsString()
  note?: string;
}

// 客户专属价：必须带商品（审批单号缺省时记警告不阻断，service 写 note）；
// 注意 CustomerPrice 无 levelType 列（专属价即一客一价，不分级）
export class CreateCustomerPriceDto {
  @IsString()
  productId!: string;

  @IsEnum(PriceUnit)
  unit!: PriceUnit;

  @IsNumber()
  @Min(0)
  price!: number;

  @IsDateString()
  validFrom!: string;

  @IsOptional()
  @IsDateString()
  validTo?: string;

  @IsOptional()
  @IsString()
  approvalRef?: string;

  @IsOptional()
  @IsString()
  note?: string;
}

export class ResolvePriceDto {
  @IsString()
  customerId!: string;

  @IsString()
  productId!: string;

  @IsOptional()
  @IsEnum(PriceUnit)
  unit?: PriceUnit;
}
