import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type JiraTaskDocument = HydratedDocument<JiraTask>;

// The activation task (PTI-key). A connection cannot go live without an active one.
@Schema({ timestamps: true, collection: 'jira_tasks' })
export class JiraTask {
  @Prop({ required: true, index: true })
  key: string;

  @Prop({ type: Types.ObjectId, ref: 'Organization', default: null })
  organization: Types.ObjectId | null;

  @Prop({ type: Types.ObjectId, ref: 'Connection', default: null })
  connection: Types.ObjectId | null;

  @Prop({ default: '' })
  statusName: string;

  @Prop({ default: false })
  isActive: boolean;

  @Prop({ default: '' })
  url: string;

  @Prop({ type: Date, default: null })
  usedForActivationAt: Date | null;
}

export const JiraTaskSchema = SchemaFactory.createForClass(JiraTask);
