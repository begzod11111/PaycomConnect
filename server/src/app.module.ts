import { Module } from '@nestjs/common';

import { PermissionsService } from './common/permissions/permissions.service';
import { ServiceAuthGuard } from './common/guards/service-auth.guard';
import { ApiController } from './http/api.controller';
import { SlackController } from './http/slack.controller';
import { TelegramController } from './http/telegram.controller';

// Cutover app: the ported runtime (src/runtime/*) provides the bridge, connections,
// persistence (Mongo + memory fallback) and delivery. Controllers mirror the old
// Express routes. The entity schemas under src/domain/* are the future model and
// are not wired yet (they will replace the runtime models after data backfill).
@Module({
  controllers: [ApiController, SlackController, TelegramController],
  providers: [PermissionsService, ServiceAuthGuard],
})
export class AppModule {}
