import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';

import { DatabaseModule } from './database/database.module';
import { HealthModule } from './health/health.module';
import { PermissionsModule } from './common/permissions/permissions.module';
import { PermissionsGuard } from './common/permissions/permissions.guard';
import { OrganizationsModule } from './domain/organizations/organizations.module';
import { UsersModule } from './domain/users/users.module';
import { ChatsModule } from './domain/chats/chats.module';
import { MembershipsModule } from './domain/memberships/memberships.module';
import { ConnectionsModule } from './domain/connections/connections.module';
import { JiraTasksModule } from './domain/jira/jira-tasks.module';
import { MessagingModule } from './domain/messaging/messaging.module';
import { OnboardingModule } from './domain/onboarding/onboarding.module';
import { AdminModule } from './api/admin/admin.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      // Reuse the repository-root .env that the Express app already uses.
      envFilePath: ['../.env', '.env'],
    }),
    DatabaseModule,
    PermissionsModule,
    HealthModule,
    // Domain modules (entities) — R1
    OrganizationsModule,
    UsersModule,
    ChatsModule,
    MembershipsModule,
    ConnectionsModule,
    JiraTasksModule,
    MessagingModule,
    OnboardingModule,
    // API surfaces
    AdminModule,
  ],
  providers: [
    // Permissions enforced globally; routes opt in with @RequirePermissions(...).
    { provide: APP_GUARD, useClass: PermissionsGuard },
  ],
})
export class AppModule {}
