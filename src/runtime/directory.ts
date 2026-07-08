import { isMongoConnected } from './database';
import { SlackUser } from './models';

// How a message author relates to us: an "employee" is one of our people
// (a registered SlackUser with a Telegram/Slack identity), everyone else is a
// "client" (the customer on the other side of the conversation).
export type SenderType = 'employee' | 'client' | 'bot' | 'system';

export interface SenderIdentity {
  // Coarse classification used across analytics/logs.
  type: SenderType;
  // The flag you asked for: "sent by our side, by our employees".
  isEmployee: boolean;
  // Reference to the registered user (SlackUser _id) when we recognise them.
  userRef: unknown | null;
  // Employee role (manager/integrator/…) when known.
  role: string | null;
  // Whether that employee account is active/approved.
  status: string | null;
  // Snapshot of the recognised display name (may differ from platform name).
  displayName: string;
}

function defaultSender(type: SenderType = 'client'): SenderIdentity {
  return {
    type,
    isEmployee: false,
    userRef: null,
    role: null,
    status: null,
    displayName: '',
  };
}

// Look up whether the given platform user is one of our registered employees.
// Falls back to a plain "client" identity in memory mode (no user directory).
export async function identifySender(
  source: string,
  externalUserId: unknown,
): Promise<SenderIdentity> {
  const normalizedId = String(externalUserId ?? '').trim();
  if (!normalizedId) return defaultSender();

  // Best-effort bot detection so bridged/system authors are not counted as clients.
  if (/^b[0-9]/i.test(normalizedId) || normalizedId.toLowerCase().includes('bot')) {
    return defaultSender('bot');
  }

  if (!isMongoConnected()) return defaultSender();

  const query =
    source === 'telegram' ? { telegramId: normalizedId } : { slackId: normalizedId };

  try {
    const user: any = await SlackUser.findOne(query).lean();
    if (!user) return defaultSender();
    return {
      type: 'employee',
      isEmployee: true,
      userRef: user._id ?? null,
      role: user.role ?? null,
      status: user.status ?? null,
      displayName: user.displayName || user.email || '',
    };
  } catch {
    return defaultSender();
  }
}
