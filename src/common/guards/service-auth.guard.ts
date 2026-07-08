import * as crypto from 'crypto';

import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
  ForbiddenException,
} from '@nestjs/common';

import { env } from '../../core/env';

// Authenticates the CALLING SERVICE (e.g. Balancer), not an end user.
// Scheme: Authorization: Basic base64("<clientName>:<secret>")  (see docs/service-auth.md)
@Injectable()
export class ServiceAuthGuard implements CanActivate {
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
    if (!env.serviceAuthEnabled) return true; // disabled in dev/tests when no clients configured

    const req = context.switchToHttp().getRequest();

    const target = req.headers['x-target-service'];
    if (target && String(target).toLowerCase() !== String(env.serviceName).toLowerCase()) {
      throw new ForbiddenException('Request addressed to a different service');
    }

    const credential = this.decode(req.headers.authorization || req.headers['x-service-authorization']);
    if (!credential?.name || !credential?.secret) {
      throw new UnauthorizedException('Service authorization required');
    }

    const expected = env.serviceClients[credential.name];
    if (!expected || !this.safeEqual(credential.secret, expected)) {
      throw new UnauthorizedException('Invalid service credentials');
    }

    req.serviceClient = { name: credential.name };
    return true;
  }
}
