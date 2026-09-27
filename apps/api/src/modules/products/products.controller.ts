// P0-T10 商品档案接口：/api 前缀由全局 main.ts 设置，此处只写相对路径；
// 认证/角色守卫为全局 APP_GUARD（app.module），控制器只需声明 @Roles
import { Body, Controller, Get, Ip, Param, Patch, Post, Query } from '@nestjs/common';
import { Roles } from '../../common/roles.guard';
import { AuthUser, CurrentUser } from '../../common/current-user.decorator';
import { ProductsService } from './products.service';
import { CreateProductDto, ListProductsDto, UpdateProductDto } from './dto';

@Controller('products')
@Roles('OWNER', 'CLERK')
export class ProductsController {
  constructor(private readonly products: ProductsService) {}

  @Get()
  list(@Query() query: ListProductsDto, @CurrentUser() user: AuthUser) {
    return this.products.list(user, query);
  }

  @Post()
  create(@Body() dto: CreateProductDto, @CurrentUser() user: AuthUser) {
    return this.products.create(user, dto);
  }

  @Get(':id')
  detail(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.products.detail(user, id);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateProductDto,
    @CurrentUser() user: AuthUser,
    @Ip() ip: string,
  ) {
    return this.products.update(user, id, dto, ip);
  }

  @Post(':id/disable')
  disable(@Param('id') id: string, @CurrentUser() user: AuthUser, @Ip() ip: string) {
    return this.products.disable(user, id, ip);
  }
}
