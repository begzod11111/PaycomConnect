import { upsertContact } from './persistenceService.js';

export async function registerInteraction(message) {
  return upsertContact({
    platform: message.source,
    userId: message.userId,
    userName: message.userName,
    channelId: message.channelId,
    messageTimestamp: message.messageTimestamp,
  });
}

