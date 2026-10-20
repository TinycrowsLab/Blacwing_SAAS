import { Controller, Get } from '@nestjs/common';

export interface ServiceInfo {
  readonly service: 'api';
  readonly status: 'ok';
}

/** `GET /v1`: proves routing under the global prefix. Carries no data and needs no tenant. */
@Controller()
export class SmokeController {
  @Get()
  info(): ServiceInfo {
    return { service: 'api', status: 'ok' };
  }
}
