import { Body, Controller, Delete, Get, Injectable, Module, Param, Patch, Post, Query } from '@nestjs/common';
import { IsArray, IsBoolean, IsEnum, IsNumber, IsObject, IsOptional, IsString, Min, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { DraftsService } from './drafts.service';
import { QwenEngineService } from './qwen-engine.service';
import { OrdersModule } from '../orders/orders.module';
import { Roles } from '../../common/roles.guard';
import { CurrentUser } from '../../common/current-user.decorator';
import type { AuthUser } from '../../common/current-user.decorator';

class CreateDraftDto {
  @IsEnum(['VOICE', 'PHOTO', 'TEXT']) source!: 'VOICE' | 'PHOTO' | 'TEXT';
  @IsOptional() @IsString() text?: string;
  @IsOptional() @IsString() photoUrl?: string;
}

class DraftItemDto {
  @IsString() productName!: string;
  @IsOptional() @IsString() productId?: string | null;
  @IsNumber() @Min(0.001) qty!: number;
  @IsString() unit!: string;
  @IsOptional() @IsNumber() unitPrice?: number | null;
}

class UpdateDraftDto {
  @IsOptional() @IsString() customerId?: string;
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => DraftItemDto) items?: DraftItemDto[];
}

class ConfirmLineDto {
  @IsString() productId!: string;
  @IsNumber() @Min(0.001) qty!: number;
  @IsEnum(['BASE', 'MIN']) unit!: 'BASE' | 'MIN';
  @IsOptional() @IsNumber() priceOverride?: number;
}

class ConfirmDraftDto {
  @IsOptional() @IsString() customerId?: string;
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => ConfirmLineDto) lines?: ConfirmLineDto[];
  @IsOptional() @IsBoolean() learnAliases?: boolean;
}

class AddAliasDto {
  @IsEnum(['PRODUCT', 'CUSTOMER']) kind!: 'PRODUCT' | 'CUSTOMER';
  @IsString() key!: string;
  @IsString() targetId!: string;
}

@Controller()
@Roles('OWNER', 'CLERK', 'REP')
export class DraftsController {
  constructor(private readonly svc: DraftsService) {}

  /** T12: 语音(转写文本)/照片(图存+人工辅助)/文字 → 可编辑草稿 */
  @Post('drafts')
  async create(@CurrentUser() user: AuthUser, @Body() dto: CreateDraftDto): Promise<unknown> {
    return this.svc.create(user, dto);
  }

  @Get('drafts')
  async list(@CurrentUser() user: AuthUser, @Query('status') status?: string, @Query('page') page?: string, @Query('pageSize') pageSize?: string): Promise<unknown> {
    return this.svc.list(user, { status, page: page ? Number(page) : undefined, pageSize: pageSize ? Number(pageSize) : undefined });
  }

  @Get('drafts/engine-status')
  async engineStatus(): Promise<unknown> {
    return this.svc.engineStatus();
  }

  @Get('drafts/:id')
  async detail(@CurrentUser() user: AuthUser, @Param('id') id: string): Promise<unknown> {
    return this.svc.detail(user, id);
  }

  /** 可编辑红线: 人工修正 items/客户 */
  @Patch('drafts/:id')
  async update(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: UpdateDraftDto): Promise<unknown> {
    return this.svc.update(user, id, dto as never);
  }

  /** 确认转单 → 仅 PENDING_CONFIRM 订单(不直接出库, D16 红线由状态机保证) */
  @Post('drafts/:id/confirm')
  async confirm(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: ConfirmDraftDto): Promise<unknown> {
    return this.svc.confirm(user, id, dto as never);
  }

  @Post('drafts/:id/discard')
  async discard(@CurrentUser() user: AuthUser, @Param('id') id: string): Promise<unknown> {
    return this.svc.discard(user, id);
  }

  @Get('aliases')
  async aliases(@Query('kind') kind?: 'PRODUCT' | 'CUSTOMER'): Promise<unknown> {
    return this.svc.aliases({ kind });
  }

  @Post('aliases')
  async addAlias(@CurrentUser() user: AuthUser, @Body() dto: AddAliasDto): Promise<unknown> {
    return this.svc.addAlias(user, dto);
  }

  @Delete('aliases/:id')
  async removeAlias(@CurrentUser() user: AuthUser, @Param('id') id: string): Promise<unknown> {
    return this.svc.removeAlias(user, id);
  }

}

@Module({ imports: [OrdersModule], controllers: [DraftsController], providers: [DraftsService, QwenEngineService] })
export class DraftsModule {}
