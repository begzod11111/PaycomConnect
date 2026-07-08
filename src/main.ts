import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module';
import { env } from './core/env';
import { connectDatabase } from './runtime/database';

async function bootstrap(): Promise<void> {
  // Connect to Mongo if configured; otherwise the persistence layer uses memory mode.
  const dbState = await connectDatabase();
  if (dbState.mode === 'memory') {
    // eslint-disable-next-line no-console
    console.warn(`MongoDB is not connected; using memory store (${dbState.lastError})`);
  }

  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix('api');
  app.enableCors();

  const port = env.port || 9010;
  await app.listen(port, env.host);
  // eslint-disable-next-line no-console
  console.log(`PaycomConnect (NestJS) listening on http://${env.host}:${port}`);
}

void bootstrap();
