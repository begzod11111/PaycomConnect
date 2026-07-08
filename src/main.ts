import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module';
import { env } from './core/env';
import { connectDatabase } from './runtime/database';

// Open an ngrok ingress tunnel (with a free static domain when NGROK_DOMAIN is set),
// mirroring the behavior the Express entrypoint used to have.
async function setupNgrok(port: number): Promise<void> {
  if (!env.enableNgrok) {
    console.log('ngrok: disabled (set NGROK_AUTHTOKEN, or ENABLE_NGROK=true, to enable).');
    return;
  }
  if (!env.ngrokAuthtoken) {
    console.warn('ngrok: enabled but NGROK_AUTHTOKEN is not set — skipping tunnel.');
    return;
  }
  try {
    const ngrok = await import('@ngrok/ngrok');
    console.log(
      `ngrok: connecting on port ${port}${env.ngrokDomain ? ` with domain ${env.ngrokDomain}` : ' (random domain)'}...`,
    );
    const listener = await ngrok.connect({
      addr: port,
      authtoken: env.ngrokAuthtoken,
      ...(env.ngrokDomain ? { domain: env.ngrokDomain } : {}),
    });
    const url = listener.url();
    console.log(`ngrok ingress established at: ${url}`);
    console.log(`Telegram webhook URL: ${url}/api/telegram/webhook`);
    console.log(`Slack webhook URL:    ${url}/api/slack/webhook`);
  } catch (error: any) {
    const message = error?.message ?? String(error);
    console.error(`Error setting up ngrok: ${message}`);
    if (/ERR_NGROK_108|simultaneous/i.test(message)) {
      console.error('ngrok: the free plan allows only ONE active session. Stop other ngrok agents/sessions and retry.');
    }
    if (/ERR_NGROK_105|authtoken/i.test(message)) {
      console.error('ngrok: check NGROK_AUTHTOKEN — copy it from https://dashboard.ngrok.com/get-started/your-authtoken');
    }
    if (env.ngrokDomain && /ERR_NGROK_(313|334|3200)|domain/i.test(message)) {
      console.error(`ngrok: check NGROK_DOMAIN "${env.ngrokDomain}" — reserve the free static domain in your ngrok dashboard first.`);
    }
  }
}

async function bootstrap(): Promise<void> {
  const dbState = await connectDatabase();
  if (dbState.mode === 'memory') {
    console.warn(`MongoDB is not connected; using memory store (${dbState.lastError})`);
  }

  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix('api');
  app.enableCors();

  const port = env.port || 9010;
  await app.listen(port, env.host);
  console.log(`PaycomConnect (NestJS) listening on http://${env.host}:${port}`);

  await setupNgrok(port);
}

void bootstrap();
