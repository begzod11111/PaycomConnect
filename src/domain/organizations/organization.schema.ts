import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type OrganizationDocument = HydratedDocument<Organization>;

// The customer, anchored by a globally-unique INN. Prevents duplicate chats for
// the same organization.
@Schema({ timestamps: true, collection: 'organizations' })
export class Organization {
  @Prop({ required: true, unique: true, index: true })
  inn: string;

  @Prop({ default: '' })
  name: string;

  @Prop({ type: Object, default: {} })
  metadata: Record<string, unknown>;
}

export const OrganizationSchema = SchemaFactory.createForClass(Organization);
