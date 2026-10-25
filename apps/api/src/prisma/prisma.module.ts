import { Global, Injectable, Module } from '@nestjs/common';
import { NotifyModule } from '../common/notify.module';
import { DbRoleCheck } from './db-role-check';
import { PrismaService } from './prisma.service';

@Injectable()
export class PrismaDummy {}

@Global()
@Module({
  imports: [NotifyModule],
  providers: [PrismaService, DbRoleCheck],
  exports: [PrismaService],
})
export class PrismaModule {}
