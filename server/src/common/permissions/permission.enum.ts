// Roles a user can have in PaycomConnect.
export enum Role {
  OWNER = 'owner',
  ADMIN = 'admin',
  TEAMLEAD = 'teamlead',
  MANAGER = 'manager',
  CX_MANAGER = 'cx_manager',
  INTEGRATOR = 'integrator',
  CLIENT = 'client',
}

// Fine-grained permissions. File/audio sending is intentionally separate so that
// "some roles can send files, some cannot" is a data decision, not code branching.
export enum Permission {
  MESSAGE_SEND = 'message:send',
  FILE_SEND = 'file:send',
  AUDIO_SEND = 'audio:send',
  CONNECTION_CREATE = 'connection:create',
  CONNECTION_REMOVE = 'connection:remove',
  CONNECTION_MANAGE = 'connection:manage',
  USER_APPROVE = 'user:approve',
  ANALYTICS_VIEW = 'analytics:view',
}
