// P0-T12 客户档案接口：写操作与列表 OWNER/CLERK/REP（REP 只见自己名下客户，service 过滤）；
// 认证/角色守卫为全局 APP_GUARD（app.module），控制器只需声明 @Roles
import { Body, Controller, Get, Ip, Param, Patch, Post, Query } from '@nestjs/common';
import { Roles } from '../../common/roles.guard';
import { AuthUser, CurrentUser } from '../../common/current-user.decorator';
import { CustomersService } from './customers.service';
import {
  CreateCustomerDto,
  ListCustomersDto,
  OnboardingActionDto,
  UpdateCustomerDto,
} from './dto';

@Controller('customers')
@Roles('OWNER', 'CLERK', 'REP')
export class CustomersController {
  constructor(private readonly customers: CustomersService) {}

  @Get()
  list(@Query() query: ListCustomersDto, @CurrentUser() user: AuthUser) {
    return this.customers.list(user, query);
  }

  @Post()
  create(@Body() dto: CreateCustomerDto, @CurrentUser() user: AuthUser) {
    return this.customers.create(user, dto);
  }

  @Get(':id')
  detail(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.customers.detail(user, id);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateCustomerDto,
    @CurrentUser() user: AuthUser,
    @Ip() ip: string,
  ) {
    return this.customers.update(user, id, dto, ip);
  }

  @Post(':id/onboarding')
  onboarding(
    @Param('id') id: string,
    @Body() dto: OnboardingActionDto,
    @CurrentUser() user: AuthUser,
    @Ip() ip: string,
  ) {
    return this.customers.onboarding(user, id, dto, ip);
  }

  @Post(':id/disable')
  disable(@Param('id') id: string, @CurrentUser() user: AuthUser, @Ip() ip: string) {
    return this.customers.disable(user, id, ip);
  }
}
