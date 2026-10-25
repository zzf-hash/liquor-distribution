import { Body, Controller, Get, Injectable, Ip, Module, Param, Post, Query, UploadedFile, UseInterceptors, BadRequestException, ConflictException } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { IsEnum, IsOptional, IsString } from 'class-validator';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ImportsService, ImportKind } from './imports.service';
import { Roles } from '../../common/roles.guard';
import { CurrentUser } from '../../common/current-user.decorator';
import type { AuthUser } from '../../common/current-user.decorator';

interface UploadFile { buffer: Buffer; originalname: string; size: number }

const IMPORT_KINDS = ['PRODUCT', 'CUSTOMER', 'PRICE', 'INVENTORY', 'RECEIVABLE'] as const;

/**
 * kind 可缺省：管理端把 kind 放在 multipart 字段里（有值时仍按枚举校验）。
 * 只放在 query 上时，不能在进控制器之前被必填校验挡成 400。
 */
export class PreviewDto {
  @IsOptional()
  @IsEnum(IMPORT_KINDS)
  kind?: ImportKind;
}

class CommitDto {
  @IsString() batchNo!: string;
  @IsOptional() @IsString() fileName?: string;
}

@Controller('imports')
@Roles('OWNER', 'CLERK')
export class ImportsController {
  constructor(private readonly svc: ImportsService) {}

  /** P0-07 预览校验: 上传→差异报告(拒行/警告/汇总), 不写入业务表 */
  @Post('preview')
  @UseInterceptors(FileInterceptor('file'))
  async preview(
    @CurrentUser() user: AuthUser,
    @UploadedFile() file: UploadFile | undefined,
    @Query('kind') kindQuery?: string,
    @Ip() ip = '' as string,
    @Body() body?: PreviewDto,
  ): Promise<unknown> {
    if (!file?.buffer?.length) throw new BadRequestException('请上传文件(multipart 字段名 file)');
    const kind = (body?.kind ?? kindQuery) as ImportKind | undefined;
    if (!kind || !(IMPORT_KINDS as readonly string[]).includes(kind)) {
      throw new BadRequestException('kind 须为 PRODUCT/CUSTOMER/PRICE/INVENTORY/RECEIVABLE');
    }
    if (file.size > 5 * 1024 * 1024) throw new BadRequestException('文件超 5MB');
    return this.svc.preview(user, kind, file.originalname, file.buffer);
  }

  /** 提交(整批原子写入, 失败零写入); 主数据提交顺序 商品→客户→价格 由依赖校验保证 */
  @Post('commit')
  async commit(@CurrentUser() user: AuthUser, @Body() dto: CommitDto, @Ip() ip: string): Promise<unknown> {
    void readFileSync; void join; void tmpdir; // commitFile 旧路径已内聚, 防未用 import 报错
    return this.svc.commit(user, dto.batchNo, ip);
  }

  @Post(':batchNo/commit')
  async commitByPath(@CurrentUser() user: AuthUser, @Param('batchNo') batchNo: string, @Ip() ip: string): Promise<unknown> {
    return this.svc.commit(user, batchNo, ip);
  }

  /** 回滚 = 冲正流水(仅库存/应收); 主数据 409 */
  @Post(':batchNo/rollback')
  async rollback(@CurrentUser() user: AuthUser, @Param('batchNo') batchNo: string, @Ip() ip: string): Promise<unknown> {
    return this.svc.rollback(user, batchNo, ip);
  }

  @Get()
  async list(@Query('page') page?: string, @Query('pageSize') pageSize?: string): Promise<unknown> {
    return this.svc.list(page ? Number(page) : 1, pageSize ? Number(pageSize) : 20);
  }

  @Get(':batchNo')
  async report(@CurrentUser() user: AuthUser, @Param('batchNo') batchNo: string): Promise<unknown> {
    return this.svc.report(user, batchNo);
  }
}

@Module({ controllers: [ImportsController], providers: [ImportsService] })
export class ImportsModule {}
