import { Module } from '@nestjs/common';
import { AuditService } from '../../audit/audit.service';
import { CustomersController } from './customers.controller';
import { CustomersService } from './customers.service';

// PrismaService 由 @Global PrismaModule 提供；AuditService 自带（无全局 AuditModule）
@Module({
  controllers: [CustomersController],
  providers: [CustomersService, AuditService],
})
export class CustomersModule {}
