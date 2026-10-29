// DEMO-STORY: renders a DemoRefusal with its own stable code. The global problem filter only passes registered
// codes through, so the demo controller uses this filter (scoped with @UseFilters) to keep codes such as
// `separation_of_duties` and `scope_outside_asset` visible to the caller and to the smoke check.
import { Catch, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';

import { DemoRefusal } from './service.js';

import type { FastifyReply } from 'fastify';

@Catch(DemoRefusal)
export class DemoRefusalFilter implements ExceptionFilter {
  catch(exception: DemoRefusal, host: ArgumentsHost): void {
    const reply = host.switchToHttp().getResponse<FastifyReply>();
    reply.status(exception.getStatus()).type('application/problem+json').send(exception.getResponse());
  }
}
