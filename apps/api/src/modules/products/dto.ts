// P0-T10 商品档案 DTO：字段口径与 prisma/schema.prisma Product 一致
import { IsBoolean, IsEnum, IsInt, IsNumber, IsOptional, IsString, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { ProductCategory, ProductStatus } from '@prisma/client';

export class ListProductsDto {
  /** 名称模糊 / 首字前缀 / 编码精确 / 条码精确 */
  @IsOptional()
  @IsString()
  q?: string;

  @IsOptional()
  @IsEnum(ProductCategory)
  category?: ProductCategory;

  @IsOptional()
  @IsEnum(ProductStatus)
  status?: ProductStatus;

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

export class CreateProductDto {
  /** 商户现用编码沿用，租户内唯一 */
  @IsString()
  skuCode!: string;

  @IsString()
  name!: string;

  @IsEnum(ProductCategory)
  category!: ProductCategory;

  @IsOptional()
  @IsString()
  brand?: string;

  /** 主单位（箱） */
  @IsString()
  baseUnit!: string;

  /** 最小单位（瓶），缺省「瓶」 */
  @IsOptional()
  @IsString()
  minUnit?: string;

  /** 整散换算：1 主单位 = packSize 最小单位 */
  @IsInt()
  @Min(1)
  packSize!: number;

  @IsOptional()
  @IsString()
  barcode?: string;

  /** 度数 */
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  abv?: number;

  @IsOptional()
  @IsString()
  origin?: string;

  @IsOptional()
  @IsString()
  supplier?: string;

  /** 规格描述，如 500ml×6 */
  @IsOptional()
  @IsString()
  specText?: string;

  /** 高值品→防盗调包标记 */
  @IsOptional()
  @IsBoolean()
  highValue?: boolean;

  /** 首字搜索 */
  @IsOptional()
  @IsString()
  pinyinFirst?: string;
}

// 改档只允许非编码字段：skuCode 是订单明细/价格行的锚点，禁改（编码变更走档案重构）
export class UpdateProductDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsEnum(ProductCategory)
  category?: ProductCategory;

  @IsOptional()
  @IsString()
  brand?: string;

  @IsOptional()
  @IsString()
  baseUnit?: string;

  @IsOptional()
  @IsString()
  minUnit?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  packSize?: number;

  @IsOptional()
  @IsString()
  barcode?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  abv?: number;

  @IsOptional()
  @IsString()
  origin?: string;

  @IsOptional()
  @IsString()
  supplier?: string;

  @IsOptional()
  @IsString()
  specText?: string;

  @IsOptional()
  @IsBoolean()
  highValue?: boolean;

  @IsOptional()
  @IsString()
  pinyinFirst?: string;
}
