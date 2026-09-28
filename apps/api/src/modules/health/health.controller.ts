import { Controller, Get, Injectable, Module } from '@nestjs/common';
import { NotifyService } from '../../common/notify.service';

@Controller('health')
export class HealthController {
  constructor(private readonly notify: NotifyService) {}

  @Get()
  health(): { ok: boolean } {
    return { ok: true };
  }

  /** 通知通道自检: off/webhook/app(+token 是否可取) */
  @Get('notify-status')
  notifyStatus(): Promise<unknown> {
    return this.notify.status();
  }
}

@Module({ controllers: [HealthController] })
export class HealthModule {}
