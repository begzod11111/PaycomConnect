import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type ConnectionDocument = HydratedDocument<Connection>;

export enum ConnectionStatus {
  PENDING_TELEGRAM = 'pending_telegram',
  PENDING_SLACK = 'pending_slack',
  LINKED = 'linked',
  SUSPENDED = 'suspended',
}

@Schema({ _id: false })
export class ConnectionStats {
  @Prop({ default: 0 })
  messagesFromTelegram: number;

  @Prop({ default: 0 })
  messagesFromSlack: number;

  @Prop({ default: 0 })
  totalMessages: number;
}

export const ConnectionStatsSchema = SchemaFactory.createForClass(ConnectionStats);

// Links a Telegram chat and a Slack chat under one organization, activated by a
// Jira task. Replaces ChannelLink, but referencing real entities.
@Schema({ timestamps: true, collection: 'connections' })
export class Connection {
  @Prop({ type: Types.ObjectId, ref: 'Organization', required: true })
  organization: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Chat', default: null })
  telegramChat: Types.ObjectId | null;

  @Prop({ type: Types.ObjectId, ref: 'Chat', default: null })
  slackChat: Types.ObjectId | null;

  @Prop({
    enum: Object.values(ConnectionStatus),
    default: ConnectionStatus.PENDING_SLACK,
    index: true,
  })
  status: ConnectionStatus;

  @Prop({ type: Types.ObjectId, ref: 'JiraTask', default: null })
  jiraTask: Types.ObjectId | null;

  @Prop({ type: [{ type: Types.ObjectId, ref: 'User' }], default: [] })
  managers: Types.ObjectId[];

  @Prop({ type: [{ type: Types.ObjectId, ref: 'User' }], default: [] })
  integrators: Types.ObjectId[];

  @Prop({ enum: ['telegram', 'slack', 'system'], default: 'system' })
  activationSource: string;

  // Persisted "awaiting PTI" flag (replaces the in-memory group connect session).
  @Prop({ default: false })
  awaitingJiraKey: boolean;

  @Prop({ type: Date, default: null })
  linkedAt: Date | null;

  @Prop({ type: Date, default: Date.now })
  lastActivityAt: Date;

  @Prop({ type: ConnectionStatsSchema, default: () => ({}) })
  stats: ConnectionStats;

  @Prop({ type: Object, default: {} })
  metadata: Record<string, unknown>;
}

export const ConnectionSchema = SchemaFactory.createForClass(Connection);

// One active (non-suspended) connection per organization.
ConnectionSchema.index(
  { organization: 1 },
  { unique: true, partialFilterExpression: { status: { $ne: ConnectionStatus.SUSPENDED } } },
);
