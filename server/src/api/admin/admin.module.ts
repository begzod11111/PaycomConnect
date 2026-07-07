import { Module } from '@nestjs/common';

import { AdminController } from './admin.controller';
import { ConnectionsModule } from '../../domain/connections/connections.module';

@Module({
  imports: [ConnectionsModule],
  controllers: [AdminController],
})
export class AdminModule {}
