import { Global, Module } from '@nestjs/common';
import { AuditService } from './audit.service';
import { AuditController } from './audit.controller';
import { IdempotencyService } from './idempotency.service';

@Global()
@Module({
  controllers: [AuditController],
  providers: [AuditService, IdempotencyService],
  exports: [AuditService, IdempotencyService],
})
export class AuditModule {}
