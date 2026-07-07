import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

import { Role } from '../../common/permissions/permission.enum';

export type MembershipDocument = HydratedDocument<Membership>;

// A user's participation in a chat, with a role. This is the explicit
// "add people to each other" record (replaces integrators[]/managers[] arrays).
@Schema({ timestamps: true, collection: 'memberships' })
export class Membership {
  @Prop({ type: Types.ObjectId, ref: 'Chat', required: true, index: true })
  chat: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true, index: true })
  user: Types.ObjectId;

  @Prop({ enum: Object.values(Role), default: Role.CLIENT })
  role: Role;

  @Prop({ type: Types.ObjectId, ref: 'User', default: null })
  addedBy: Types.ObjectId | null;
}

export const MembershipSchema = SchemaFactory.createForClass(Membership);

MembershipSchema.index({ chat: 1, user: 1 }, { unique: true });
