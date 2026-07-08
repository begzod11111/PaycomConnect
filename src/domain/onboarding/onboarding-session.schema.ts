import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type OnboardingSessionDocument = HydratedDocument<OnboardingSession>;

export enum OnboardingState {
  STARTED = 'started',
  EMAIL_PROVIDED = 'email_provided',
  CODE_SENT = 'code_sent',
  VERIFIED = 'verified',
  ACTIVE = 'active',
  REJECTED = 'rejected',
}

// Persisted onboarding state machine (replaces the two in-memory DM flows).
@Schema({ timestamps: true, collection: 'onboarding_sessions' })
export class OnboardingSession {
  @Prop({ required: true, enum: ['telegram', 'slack'], index: true })
  platform: 'telegram' | 'slack';

  @Prop({ required: true, index: true })
  identityExternalId: string;

  @Prop({ type: Types.ObjectId, ref: 'User', default: null })
  user: Types.ObjectId | null;

  @Prop({ enum: Object.values(OnboardingState), default: OnboardingState.STARTED, index: true })
  state: OnboardingState;

  @Prop({ default: '' })
  email: string;

  // Hashed verification code — never plaintext.
  @Prop({ default: '' })
  codeHash: string;

  @Prop({ default: 0 })
  attempts: number;

  @Prop({ type: Date, default: null })
  expiresAt: Date | null;
}

export const OnboardingSessionSchema = SchemaFactory.createForClass(OnboardingSession);

OnboardingSessionSchema.index({ platform: 1, identityExternalId: 1 }, { unique: true });
