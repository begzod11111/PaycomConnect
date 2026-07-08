import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module';
import { env } from './core/env';
import { connectDatabase } from './runtime/database';
import { startNgrokTunnel, stopNgrokTunnel } from './runtime/ngrok';

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

  // Open a public ngrok tunnel so Telegram/Slack webhooks can reach a local server.
  const ngrokState = await startNgrokTunnel(port);
  if (ngrokState.enabled && ngrokState.url) {
    // eslint-disable-next-line no-console
    console.log(`ngrok tunnel: ${ngrokState.url}`);
    // eslint-disable-next-line no-console
    console.log(`Telegram webhook URL: ${ngrokState.url}/api/telegram/webhook`);
    const closeTunnel = (): void => {
      void stopNgrokTunnel();
    };
    process.once('SIGINT', closeTunnel);
    process.once('SIGTERM', closeTunnel);
  } else if (ngrokState.reason && ngrokState.reason !== 'disabled') {
    // eslint-disable-next-line no-console
    console.warn(`ngrok tunnel not started: ${ngrokState.reason}`);
  }
}

void bootstrap();
