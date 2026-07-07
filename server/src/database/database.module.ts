import { Global, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';

// Single Mongo bootstrap for the NestJS app (replaces the two Express bootstraps
// in databaseService.js and models/db.js). Keeps MongoDB as agreed.
@Global()
@Module({
  imports: [
    MongooseModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        uri:
          config.get<string>('MONGODB_URI') ||
          'mongodb://127.0.0.1:27017/paycomconnect',
        // Fail fast instead of buffering forever when Mongo is unreachable.
        serverSelectionTimeoutMS: 5000,
      }),
    }),
  ],
})
export class DatabaseModule {}
