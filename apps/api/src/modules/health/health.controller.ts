import { Controller, Get, Injectable, Module } from '@nestjs/common';

@Controller('health')
export class HealthController {
  @Get()
  health(): { ok: boolean } {
    return { ok: true };
  }
}

@Module({ controllers: [HealthController] })
export class HealthModule {}
