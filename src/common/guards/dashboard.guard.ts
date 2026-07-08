import { CanActivate, Injectable, NotFoundException } from '@nestjs/common';

import { env } from '../../core/env';

// Gate the local inspection dashboard behind an env flag. When disabled we throw
// 404 (not 403) so the routes look like they don't exist at all — the dashboard
// is meant for local/port-forwarded access only, not public exposure.
@Injectable()
export class DashboardGuard implements CanActivate {
  canActivate(): boolean {
    if (!env.enableDashboard) {
      throw new NotFoundException('Not found');
    }
    return true;
  }
}
