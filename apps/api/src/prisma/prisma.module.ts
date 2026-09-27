import { Global, Injectable, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';

@Injectable()
export class PrismaDummy {}

@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
