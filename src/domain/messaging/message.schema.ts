import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type MessageDocument = HydratedDocument<Message>;

export type Platform = 'telegram' | 'slack';

// One forwarded attachment with all the metadata you asked to store:
// kind, format/mime, size, and media dimensions/duration.
@Schema({ _id: false })
export class Attachment {
  @Prop({ enum: ['photo', 'video', 'audio', 'voice', 'video_note', 'document', 'file'], default: 'file' })
  kind: string;

  @Prop({ default: '' })
  name: string;

  @Prop({ default: '' })
  mimeType: string;

  // e.g. "jpg", "mp4", "ogg" — convenient for filtering/analytics.
  @Prop({ default: '' })
  format: string;

  @Prop({ default: 0 })
  sizeBytes: number;

  @Prop({ default: 0 })
  width: number;

  @Prop({ default: 0 })
  height: number;

  @Prop({ default: 0 })
  durationSec: number;

  // Provider file identifiers, for re-download / dedupe.
  @Prop({ default: '' })
  telegramFileId: string;

  @Prop({ default: '' })
  slackFileId: string;
}

export const AttachmentSchema = SchemaFactory.createForClass(Attachment);

// Author snapshot (who sent it), even if not a registered User.
@Schema({ _id: false })
export class MessageAuthor {
  @Prop({ type: Types.ObjectId, ref: 'User', default: null })
  userId: Types.ObjectId | null;

  @Prop({ enum: ['telegram', 'slack'], required: true })
  platform: Platform;

  @Prop({ default: '' })
  externalId: string;

  @Prop({ default: '' })
  displayName: string;

  @Prop({ default: '' })
  username: string;

  // Author classification: 'employee' means one of our people (a registered
  // User), 'client' is the customer on the other side.
  @Prop({ enum: ['employee', 'client', 'bot', 'system'], default: 'client' })
  type: string;

  // The flag: "sent by our side, by our employees".
  @Prop({ default: false })
  isEmployee: boolean;

  // Employee role (manager/integrator/…) when known.
  @Prop({ default: '' })
  role: string;
}

export const MessageAuthorSchema = SchemaFactory.createForClass(MessageAuthor);

// Delivery outcome and timing (latency) of the forward.
@Schema({ _id: false })
export class Delivery {
  @Prop({ enum: ['pending', 'sent', 'mocked', 'failed', 'skipped'], default: 'pending' })
  status: string;

  @Prop({ enum: ['live', 'mock', 'control'], default: 'live' })
  mode: string;

  @Prop({ default: '' })
  providerMessageId: string;

  @Prop({ default: '' })
  error: string;

  @Prop({ default: 0 })
  attempts: number;

  @Prop({ default: 0 })
  latencyMs: number;

  // Whether the message was actually delivered (rendered) on the destination
  // side — a quick boolean mirror of `status`.
  @Prop({ default: false })
  delivered: boolean;
}

export const DeliverySchema = SchemaFactory.createForClass(Delivery);

// Full audit record of a bridged message with rich metadata:
// time, who sent, which side (telegram/slack), direction, sizes and formats.
@Schema({ timestamps: true, collection: 'messages' })
export class Message {
  @Prop({ type: Types.ObjectId, ref: 'Connection', default: null, index: true })
  connection: Types.ObjectId | null;

  @Prop({ type: Types.ObjectId, ref: 'Chat', default: null })
  sourceChat: Types.ObjectId | null;

  @Prop({ required: true, enum: ['telegram', 'slack'], index: true })
  source: Platform;

  @Prop({ required: true, enum: ['telegram', 'slack'] })
  destination: Platform;

  @Prop({ enum: ['telegram_to_slack', 'slack_to_telegram'], required: true })
  direction: string;

  @Prop({ required: true })
  externalId: string;

  @Prop({ type: MessageAuthorSchema, required: true })
  author: MessageAuthor;

  @Prop({ default: '' })
  text: string;

  @Prop({ default: 0 })
  textLength: number;

  // Content shape of the message: pure text, a file/attachment, both, or empty.
  @Prop({ enum: ['text', 'file', 'mixed', 'empty'], default: 'text', index: true })
  format: string;

  @Prop({ type: [AttachmentSchema], default: [] })
  attachments: Attachment[];

  // Sum of attachment sizes — quick analytics on transferred volume.
  @Prop({ default: 0 })
  totalSizeBytes: number;

  @Prop({ type: DeliverySchema, default: () => ({}) })
  delivery: Delivery;

  // Timeline of the message across the bridge.
  @Prop({ type: Date, default: null })
  sentAt: Date | null;

  @Prop({ type: Date, default: Date.now })
  receivedAt: Date;

  @Prop({ type: Date, default: null })
  deliveredAt: Date | null;

  @Prop({ type: Object, default: {} })
  metadata: Record<string, unknown>;
}

export const MessageSchema = SchemaFactory.createForClass(Message);

// Dedupe: a source message is stored once.
MessageSchema.index({ source: 1, externalId: 1 }, { unique: true });
