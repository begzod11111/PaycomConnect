import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { Connection, ConnectionSchema } from './connection.schema';

@Module({
  imports: [MongooseModule.forFeature([{ name: Connection.name, schema: ConnectionSchema }])],
  exports: [MongooseModule],
})
export class ConnectionsModule {}
