import { Controller, Get } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection } from 'mongoose';

@Controller('health')
export class HealthController {
  constructor(@InjectConnection() private readonly mongo: Connection) {}

  @Get()
  check() {
    // mongoose readyState: 0 disconnected, 1 connected, 2 connecting, 3 disconnecting
    const states = ['disconnected', 'connected', 'connecting', 'disconnecting'];
    return {
      status: 'ok',
      service: 'PaycomConnect',
      runtime: 'nestjs',
      version: '0.1.0',
      database: states[this.mongo?.readyState] ?? 'unknown',
      uptime: process.uptime(),
    };
  }
}
