import { Global, Module } from '@nestjs/common';
import { AsrService } from './asr.service';

@Global()
@Module({ providers: [AsrService], exports: [AsrService] })
export class AsrModule {}
