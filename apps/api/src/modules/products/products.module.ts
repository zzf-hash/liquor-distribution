import { Module } from '@nestjs/common';
import { AuditService } from '../../audit/audit.service';
import { ProductsController } from './products.controller';
import { ProductsService } from './products.service';

// PrismaService 由 @Global PrismaModule 提供；AuditService 自带（无全局 AuditModule）
@Module({
  controllers: [ProductsController],
  providers: [ProductsService, AuditService],
})
export class ProductsModule {}
