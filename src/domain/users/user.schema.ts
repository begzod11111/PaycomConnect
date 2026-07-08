import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

import { Role } from '../../common/permissions/permission.enum';

export type UserDocument = HydratedDocument<User>;

// One platform login of a user (Telegram or Slack). A person can have both.
@Schema({ _id: false })
export class Identity {
  @Prop({ required: true, enum: ['telegram', 'slack'] })
  platform: 'telegram' | 'slack';

  @Prop({ required: true })
  externalId: string;

  @Prop({ default: '' })
  username: string;

  @Prop({ type: Date, default: Date.now })
  linkedAt: Date;
}

export const IdentitySchema = SchemaFactory.createForClass(Identity);

@Schema({ timestamps: true, collection: 'users' })
export class User {
  @Prop({ default: '' })
  displayName: string;

  @Prop({ default: '', index: true })
  email: string;

  @Prop({ enum: Object.values(Role), default: Role.CLIENT, index: true })
  role: Role;

  @Prop({ enum: ['pending', 'active', 'suspended'], default: 'pending', index: true })
  status: 'pending' | 'active' | 'suspended';

  @Prop({ type: [IdentitySchema], default: [] })
  identities: Identity[];

  // Hashed only — never store plaintext (fixes the current onboarding issue).
  @Prop({ default: '' })
  passwordHash: string;

  @Prop({ type: [{ type: Types.ObjectId, ref: 'Connection' }], default: [] })
  connects: Types.ObjectId[];

  @Prop({ type: Object, default: {} })
  metadata: Record<string, unknown>;
}

export const UserSchema = SchemaFactory.createForClass(User);

// Look up a user by any of their platform identities.
UserSchema.index({ 'identities.platform': 1, 'identities.externalId': 1 });
