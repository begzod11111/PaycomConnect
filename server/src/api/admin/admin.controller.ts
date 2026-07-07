import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { ServiceAuthGuard } from '../../common/guards/service-auth.guard';
import { Connection } from '../../domain/connections/connection.schema';

// Data/admin surface consumed by the tamada / Balancer UI. Protected by the
// service credential (not user auth). Example endpoint for R2; more to follow.
@Controller('admin')
@UseGuards(ServiceAuthGuard)
export class AdminController {
  constructor(
    @InjectModel(Connection.name) private readonly connectionModel: Model<Connection>,
  ) {}

  @Get('connections')
  async listConnections(@Query('limit') limit?: string) {
    const max = Math.min(Number(limit) || 50, 200);
    return this.connectionModel
      .find()
      .sort({ lastActivityAt: -1 })
      .limit(max)
      .lean()
      .exec();
  }
}
