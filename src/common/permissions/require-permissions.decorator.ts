import { SetMetadata } from '@nestjs/common';

import { Permission } from './permission.enum';

export const PERMISSIONS_KEY = 'required_permissions';

// Usage: @RequirePermissions(Permission.CONNECTION_CREATE)
export const RequirePermissions = (...permissions: Permission[]) =>
  SetMetadata(PERMISSIONS_KEY, permissions);
