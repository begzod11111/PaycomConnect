import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type ChatDocument = HydratedDocument<Chat>;

// Per-chat settings, including media/permission overrides layered on top of roles.
@Schema({ _id: false })
export class ChatSettings {
  @Prop({ default: true })
  allowFiles: boolean;

  @Prop({ default: true })
  allowAudio: boolean;

  @Prop({ default: false })
  muted: boolean;

  // Outbound rate limit hint for this chat (messages/minute); enforced by the limiter.
  @Prop({ default: 20 })
  rateLimitPerMinute: number;
}

export const ChatSettingsSchema = SchemaFactory.createForClass(ChatSettings);

// A single conversation surface: a Telegram group OR a Slack channel.
// "A chat is one entity with many functions" — membership, settings, message
// history and its role in a Connection all reference this.
@Schema({ timestamps: true, collection: 'chats' })
export class Chat {
  @Prop({ required: true, enum: ['telegram', 'slack'], index: true })
  platform: 'telegram' | 'slack';

  @Prop({ required: true, index: true })
  externalId: string;

  @Prop({ default: '' })
  title: string;

  @Prop({ enum: ['group', 'supergroup', 'channel', 'im', 'unknown'], default: 'unknown' })
  type: string;

  @Prop({ type: ChatSettingsSchema, default: () => ({}) })
  settings: ChatSettings;

  @Prop({ type: Object, default: {} })
  metadata: Record<string, unknown>;
}

export const ChatSchema = SchemaFactory.createForClass(Chat);

ChatSchema.index({ platform: 1, externalId: 1 }, { unique: true });
