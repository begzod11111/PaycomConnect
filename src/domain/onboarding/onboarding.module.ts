import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { OnboardingSession, OnboardingSessionSchema } from './onboarding-session.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: OnboardingSession.name, schema: OnboardingSessionSchema },
    ]),
  ],
  exports: [MongooseModule],
})
export class OnboardingModule {}
