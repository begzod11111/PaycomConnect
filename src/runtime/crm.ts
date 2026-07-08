import { upsertContact } from './persistence';

// Faithful port of services/crmService.js
export async function registerInteraction(message: any) {
  return upsertContact({
    platform: message.source,
    userId: message.userId,
    userName: message.userName,
    channelId: message.channelId,
    messageTimestamp: message.messageTimestamp,
  });
}
