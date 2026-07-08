import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { ActionLog, ActionLogSchema } from './action-log.schema';

@Module({
  imports: [MongooseModule.forFeature([{ name: ActionLog.name, schema: ActionLogSchema }])],
  exports: [MongooseModule],
})
export class LogsModule {}
