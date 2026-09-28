import { Body, Controller, Get, Injectable, Ip, Module, Param, Post, Query } from '@nestjs/common';
import { IsEnum, IsString, MinLength } from 'class-validator';
import { ApprovalsService } from './approvals.service';
import { Roles } from '../../common/roles.guard';
import { CurrentUser } from '../../common/current-user.decorator';
import type { AuthUser } from '../../common/current-user.decorator';

class DecideDto {
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

  @Post(':id/decide')
  async decide(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: DecideDto, @Ip() ip: string): Promise<unknown> {
    return this.svc.decide(user, id, dto, ip);
  }
}

@Module({ controllers: [ApprovalsController], providers: [ApprovalsService], exports: [ApprovalsService] })
export class ApprovalsModule {}
