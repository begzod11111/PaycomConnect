import * as crypto from 'crypto';

import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
  ForbiddenException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

// Port of middleware/serviceAuth.js to a NestJS guard.
// Authenticates the CALLING SERVICE (e.g. Balancer), not an end user.
// Scheme: Authorization: Basic base64("<clientName>:<secret>")  (see docs/service-auth.md)
@Injectable()
export class ServiceAuthGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  private parseClients(): Record<string, string> {
    const raw = this.config.get<string>('SERVICE_CLIENTS') ?? '';
    const clients: Record<string, string> = {};
    for (const pair of raw.split(',')) {
      const trimmed = pair.trim();
      const idx = trimmed.indexOf(':');
      if (idx === -1) continue;
      const name = trimmed.slice(0, idx).trim();
      const secret = trimmed.slice(idx + 1).trim();
      if (name && secret) clients[name] = secret;
    }
    return clients;
  }

  private isEnabled(clients: Record<string, string>): boolean {
    const override = this.config.get<string>('SERVICE_AUTH_ENABLED');
    if (override !== undefined && override !== '') {
      return ['1', 'true', 'yes', 'on'].includes(override.toLowerCase());
    }
    return Object.keys(clients).length > 0;
  }

  private safeEqual(a: string, b: string): boolean {
    const ba = Buffer.from(a, 'utf8');
    const bb = Buffer.from(b, 'utf8');
    if (ba.length !== bb.length) {
      crypto.timingSafeEqual(ba, ba);
      return false;
    }
    return crypto.timingSafeEqual(ba, bb);
  }

  private decode(header?: string): { name: string; secret: string } | null {
    if (!header) return null;
    const match = header.match(/^(?:Basic|Service)\s+(.+)$/i);
    const b64 = match ? match[1].trim() : header.trim();
    let decoded: string;
    try {
      decoded = Buffer.from(b64, 'base64').toString('utf8');
    } catch {
      return null;
    }
    const idx = decoded.indexOf(':');
    if (idx === -1) return null;
    return { name: decoded.slice(0, idx), secret: decoded.slice(idx + 1) };
  }

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    const clients = this.parseClients();

    if (!this.isEnabled(clients)) {
      return true; // disabled in dev/tests when no clients configured
    }

    const serviceName = this.config.get<string>('SERVICE_NAME') ?? 'paycomconnect';
    const target = req.headers['x-target-service'];
    if (target && String(target).toLowerCase() !== serviceName.toLowerCase()) {
      throw new ForbiddenException('Request addressed to a different service');
    }

    const credential = this.decode(
      req.headers.authorization || req.headers['x-service-authorization'],
    );
    if (!credential?.name || !credential?.secret) {
      throw new UnauthorizedException('Service authorization required');
    }

    const expected = clients[credential.name];
    if (!expected || !this.safeEqual(credential.secret, expected)) {
      throw new UnauthorizedException('Invalid service credentials');
    }

    req.serviceClient = { name: credential.name };
    return true;
  }
}
