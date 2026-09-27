import { Module } from '@nestjs/common';
import { AuditService } from '../../audit/audit.service';
import {
  CustomerPricesController,
  PriceResolveController,
  ProductPricesController,
} from './prices.controller';
import { PricesService } from './prices.service';

// PrismaService 由 @Global PrismaModule 提供；AuditService 自带（无全局 AuditModule）
@Module({
  controllers: [ProductPricesController, CustomerPricesController, PriceResolveController],
  providers: [PricesService, AuditService],
})
export class PricesModule {}
