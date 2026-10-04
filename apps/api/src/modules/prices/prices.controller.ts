// P0-T11 价格接口：商品五级价 / 客户专属价 / 取价引擎，路径按资源挂在 products|customers|prices 下；
// 认证/角色守卫为全局 APP_GUARD（app.module），控制器只需声明 @Roles
import { Body, Controller, Get, Ip, Param, Post, Query } from '@nestjs/common';
import { Roles } from '../../common/roles.guard';
import { AuthUser, CurrentUser } from '../../common/current-user.decorator';
import { PricesService } from './prices.service';
import { CreateCustomerPriceDto, CreateProductPriceDto, ResolvePriceDto } from './dto';

@Controller('products')
@Roles('OWNER', 'CLERK')
export class ProductPricesController {
  constructor(private readonly prices: PricesService) {}

  @Get(':id/prices')
  list(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.prices.listForProduct(user, id);
  }

  @Post(':id/prices')
  create(
    @Param('id') id: string,
    @Body() dto: CreateProductPriceDto,
    @CurrentUser() user: AuthUser,
    @Ip() ip: string,
  ) {
    return this.prices.createForProduct(user, id, dto, ip);
  }
}

@Controller('customers')
@Roles('OWNER', 'CLERK')
export class CustomerPricesController {
  constructor(private readonly prices: PricesService) {}

  @Get(':id/prices')
  list(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.prices.listForCustomer(user, id);
  }

  @Post(':id/prices')
  create(
    @Param('id') id: string,
    @Body() dto: CreateCustomerPriceDto,
    @CurrentUser() user: AuthUser,
    @Ip() ip: string,
  ) {
    return this.prices.createForCustomer(user, id, dto, ip);
  }
}

@Controller('prices')
@Roles('OWNER', 'CLERK')
export class PriceResolveController {
  constructor(private readonly prices: PricesService) {}

  /** 取价引擎（只读）：下单/导价共用，优先级 客户专属价>TERMINAL>TIER2>TIER1>RETAIL
   *  2026-10 审查修复: 对 REP 开放(业务员代下单此前 403); COST 成本价本就不在 resolve 链内 */
  @Get('resolve')
  @Roles('OWNER', 'CLERK', 'REP')
  resolve(@Query() query: ResolvePriceDto, @CurrentUser() user: AuthUser) {
    return this.prices.resolve(user, query);
  }
}
