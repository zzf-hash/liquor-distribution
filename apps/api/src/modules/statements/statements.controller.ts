import { Body, Controller, Get, Injectable, Module, Param, Post, Query } from '@nestjs/common';
import { IsArray, IsEnum, IsOptional, IsString, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { StatementsService } from './statements.service';
import { Roles } from '../../common/roles.guard';
import { CurrentUser } from '../../common/current-user.decorator';
import type { AuthUser } from '../../common/current-user.decorator';

class GenerateDto {
  @IsString() customerId!: string;
  @IsString() period!: string;
}

class DisputeItemDto {
  @IsEnum(['MISSING_ORDER', 'PRICE', 'GIFT', 'RETURN']) type!: 'MISSING_ORDER' | 'PRICE' | 'GIFT' | 'RETURN';
  @IsString() content!: string;
}

class DisputeDto {
  @IsArray() @ValidateNested({ each: true }) @Type(() => DisputeItemDto) items!: DisputeItemDto[];
}

class ResolveDto {
  @IsString() resolution!: string;
}

@Controller('statements')
@Roles('OWNER', 'CLERK', 'CUSTOMER')
export class StatementsController {
  constructor(private readonly svc: StatementsService) {}

  @Post('generate')
  @Roles('OWNER', 'CLERK')
  async generate(@CurrentUser() user: AuthUser, @Body() dto: GenerateDto): Promise<unknown> {
    return this.svc.generate(user, dto);
  }

  @Get()
  async list(@CurrentUser() user: AuthUser, @Query('status') status?: string, @Query('customerId') customerId?: string, @Query('period') period?: string): Promise<unknown> {
    return this.svc.list(user, { status, customerId, period });
  }

  @Get(':id')
  async detail(@CurrentUser() user: AuthUser, @Param('id') id: string): Promise<unknown> {
    return this.svc.detail(user, id);
  }

  @Post(':id/send')
  @Roles('OWNER', 'CLERK')
  async send(@CurrentUser() user: AuthUser, @Param('id') id: string): Promise<unknown> {
    return this.svc.send(user, id);
  }

  /** 客户确认(客户 token; 内勤可代) */
  @Post(':id/confirm')
  async confirm(@CurrentUser() user: AuthUser, @Param('id') id: string): Promise<unknown> {
    return this.svc.confirm(user, id);
  }

  /** 客户异议: 差异四类进工作池 */
  @Post(':id/dispute')
  async dispute(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: DisputeDto): Promise<unknown> {
    return this.svc.dispute(user, id, dto.items);
  }

  @Post('disputes/:disputeId/resolve')
  @Roles('OWNER', 'CLERK')
  async resolveDispute(@CurrentUser() user: AuthUser, @Param('disputeId') disputeId: string, @Body() dto: ResolveDto): Promise<unknown> {
    return this.svc.resolveDispute(user, disputeId, dto.resolution);
  }
}

@Module({ controllers: [StatementsController], providers: [StatementsService] })
export class StatementsModule {}
