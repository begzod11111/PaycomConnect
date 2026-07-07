import { Permission, Role } from './permission.enum';

// Default role → permission matrix. This is the single place that answers
// "who can send files / audio / connect / view analytics". Per-chat overrides
// (e.g. a muted chat) are layered on top by ChatSettings at runtime.
export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  [Role.OWNER]: Object.values(Permission),
  [Role.ADMIN]: Object.values(Permission),
  [Role.TEAMLEAD]: [
    Permission.MESSAGE_SEND,
    Permission.FILE_SEND,
    Permission.AUDIO_SEND,
    Permission.CONNECTION_CREATE,
    Permission.CONNECTION_REMOVE,
    Permission.CONNECTION_MANAGE,
    Permission.USER_APPROVE,
    Permission.ANALYTICS_VIEW,
  ],
  [Role.MANAGER]: [
    Permission.MESSAGE_SEND,
    Permission.FILE_SEND,
    Permission.AUDIO_SEND,
    Permission.CONNECTION_CREATE,
    Permission.CONNECTION_REMOVE,
    Permission.ANALYTICS_VIEW,
  ],
  [Role.CX_MANAGER]: [
    Permission.MESSAGE_SEND,
    Permission.FILE_SEND,
    Permission.AUDIO_SEND,
    Permission.ANALYTICS_VIEW,
  ],
  [Role.INTEGRATOR]: [
    Permission.MESSAGE_SEND,
    Permission.FILE_SEND,
    Permission.AUDIO_SEND,
  ],
  // Clients (end users in the Telegram group): text only by default.
  [Role.CLIENT]: [Permission.MESSAGE_SEND],
};
