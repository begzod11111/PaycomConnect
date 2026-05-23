import { ChannelLink } from '../models/channelLink.js';
import { SlackUser } from '../models/slackUser.js';

export class IntegrationDistributionService {
  static async getIntegratorsWithActiveLoad() {
    const integrators = await SlackUser.find({
      status: 'active',
      role: 'integrator',
      slackId: { $exists: true, $ne: '' },
    }).lean();

    if (!integrators.length) {
      return [];
    }

    const integratorIds = integrators.map((item) => item._id);
    const loadRows = await ChannelLink.aggregate([
      {
        $match: {
          status: 'linked',
          integrators: { $in: integratorIds },
        },
      },
      { $unwind: '$integrators' },
      {
        $match: {
          integrators: { $in: integratorIds },
        },
      },
      {
        $group: {
          _id: '$integrators',
          activeConnects: { $sum: 1 },
        },
      },
    ]);

    const loadMap = new Map(loadRows.map((row) => [String(row._id), row.activeConnects]));

    return integrators
      .map((item) => ({
        ...item,
        activeConnects: Number(loadMap.get(String(item._id)) ?? 0),
      }))
      .sort((left, right) => {
        if (left.activeConnects !== right.activeConnects) {
          return left.activeConnects - right.activeConnects;
        }
        return new Date(left.updatedAt || 0).getTime() - new Date(right.updatedAt || 0).getTime();
      });
  }

  static async pickIntegratorsForConnect(limit = 1) {
    const list = await IntegrationDistributionService.getIntegratorsWithActiveLoad();
    return list.slice(0, Math.max(1, limit));
  }
}

