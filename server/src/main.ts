import 'reflect-metadata';

import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);

  app.setGlobalPrefix('api');
  app.enableCors();
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: false,
    }),
  );

  // Different port from the Express app (9010) so both can run during the strangler phase.
  const port = process.env.NEST_PORT ? Number(process.env.NEST_PORT) : 9020;
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`PaycomConnect (NestJS) listening on http://0.0.0.0:${port}`);
}

void bootstrap();
