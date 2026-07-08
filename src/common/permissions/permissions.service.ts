import { Injectable } from '@nestjs/common';

import { Permission, Role } from './permission.enum';
import { ROLE_PERMISSIONS } from './role-permissions';

@Injectable()
export class PermissionsService {
  can(role: Role | string | undefined, permission: Permission): boolean {
    if (!role) return false;
    const granted = ROLE_PERMISSIONS[role as Role];
    return Array.isArray(granted) && granted.includes(permission);
  }

  permissionsFor(role: Role | string | undefined): Permission[] {
    if (!role) return [];
    return ROLE_PERMISSIONS[role as Role] ?? [];
  }
}
