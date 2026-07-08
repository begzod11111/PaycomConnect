import { Global, Module } from '@nestjs/common';

import { PermissionsService } from './permissions.service';
import { ServiceAuthGuard } from '../guards/service-auth.guard';

@Global()
@Module({
  providers: [PermissionsService, ServiceAuthGuard],
  exports: [PermissionsService, ServiceAuthGuard],
})
export class PermissionsModule {}
