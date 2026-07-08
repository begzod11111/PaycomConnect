import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type ActionLogDocument = HydratedDocument<ActionLog>;

export enum ActionLogCategory {
  MESSAGE = 'message',
  CONNECTION = 'connection',
  JIRA = 'jira',
  ONBOARDING = 'onboarding',
  SYSTEM = 'system',
}

export enum ActionLogLevel {
  INFO = 'info',
  WARN = 'warn',
  ERROR = 'error',
}

// Who performed / triggered the action (may be one of our employees or a client).
@Schema({ _id: false })
export class ActionLogActor {
  @Prop({ type: Types.ObjectId, ref: 'User', default: null })
  userRef: Types.ObjectId | null;

  @Prop({ default: '' })
  userId: string;

  @Prop({ default: '' })
  userName: string;

  @Prop({ default: false })
  isEmployee: boolean;
}

export const ActionLogActorSchema = SchemaFactory.createForClass(ActionLogActor);

// A dedicated entity for logs of actions across the bridge (messages received /
// forwarded / not forwarded, connections activated, Jira triggered, …). Kept
// separate from Message so operational history is queryable on its own.
@Schema({ timestamps: true, collection: 'action_logs' })
export class ActionLog {
  @Prop({ required: true, index: true })
  action: string;

  @Prop({ enum: Object.values(ActionLogCategory), default: ActionLogCategory.SYSTEM, index: true })
  category: ActionLogCategory;

  @Prop({ enum: Object.values(ActionLogLevel), default: ActionLogLevel.INFO })
  level: ActionLogLevel;

  @Prop({ enum: ['telegram', 'slack', 'system'], default: 'system' })
  source: string;

  @Prop({ default: '' })
  message: string;

  @Prop({ type: ActionLogActorSchema, default: () => ({}) })
  actor: ActionLogActor;

  @Prop({ default: '', index: true })
  connectionInn: string;

  @Prop({ default: '' })
  externalId: string;

  @Prop({ type: Object, default: {} })
  context: Record<string, unknown>;
}

export const ActionLogSchema = SchemaFactory.createForClass(ActionLog);

ActionLogSchema.index({ createdAt: -1 });
ActionLogSchema.index({ category: 1, action: 1 });
