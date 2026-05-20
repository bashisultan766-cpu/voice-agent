import { Controller, Get } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { UserRole } from '@prisma/client';
import { TenantId } from '../../common/decorators/tenant-id.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { ClientsService } from './clients.service';

@Controller('clients')
@Roles(UserRole.MANAGER)
export class ClientsController {
  constructor(private readonly clientsService: ClientsService) {}

  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get()
  findAll(@TenantId() tenantId: string) {
    return this.clientsService.findAll(tenantId);
  }
}
