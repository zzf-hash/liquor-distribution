import { Body, Controller, Get, Injectable, Ip, Module, Param, Post, Query } from '@nestjs/common';
import { ArrayMaxSize, IsArray, IsEnum, IsString, MinLength } from 'class-validator';
import { ApprovalsService } from './approvals.service';
import { Roles } from '../../common/roles.guard';
import { CurrentUser } from '../../common/current-user.decorator';
import type { AuthUser } from '../../common/current-user.decorator';

class DecideDto {
  @IsEnum(['approve', 'reject']) action!: 'approve' | 'reject';
  @IsString() @MinLength(1) opinion!: string;
}

/** C组: 批量决定(批量调价等一单一审批场景); 逐单走 decide 全套校验, 单条失败不拖垮批次 */
class BulkDecideDto {
  @IsArray() @ArrayMaxSize(100) ids!: string[];
  @IsEnum(['approve', 'reject']) action!: 'approve' | 'reject';
  @IsString() @MinLength(1) opinion!: string;
}

@Controller('approvals')
@Roles('OWNER', 'CLERK')
export class ApprovalsController {
  constructor(private readonly svc: ApprovalsService) {}

  @Get()
  async list(
    @CurrentUser() user: AuthUser,
    @Query('status') status?: 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXPIRED_24H',
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ): Promise<unknown> {
    return this.svc.list(user, { status, page: page ? Number(page) : undefined, pageSize: pageSize ? Number(pageSize) : undefined });
  }

  @Post('bulk-decide')
  async bulkDecide(@CurrentUser() user: AuthUser, @Body() dto: BulkDecideDto, @Ip() ip: string): Promise<unknown> {
    const applied: Array<{ id: string; approved: boolean }> = [];
    const failed: Array<{ id: string; error: string }> = [];
    for (const id of dto.ids) {
      try {
        const res = (await this.svc.decide(user, id, { action: dto.action, opinion: dto.opinion }, ip)) as { approved: boolean };
        applied.push({ id, approved: res.approved });
      } catch (e) {
        failed.push({ id, error: String((e as Error).message ?? e).slice(0, 120) });
      }
    }
    return { applied: applied.length, failed, items: applied };
  }

  @Post(':id/decide')
  async decide(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: DecideDto, @Ip() ip: string): Promise<unknown> {
    return this.svc.decide(user, id, dto, ip);
  }
}

@Module({ controllers: [ApprovalsController], providers: [ApprovalsService], exports: [ApprovalsService] })
export class ApprovalsModule {}
