import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { JiraTask, JiraTaskSchema } from './jira-task.schema';

@Module({
  imports: [MongooseModule.forFeature([{ name: JiraTask.name, schema: JiraTaskSchema }])],
  exports: [MongooseModule],
})
export class JiraTasksModule {}
