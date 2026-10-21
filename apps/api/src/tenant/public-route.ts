import { SetMetadata } from '@nestjs/common';

/** Metadata key of {@link PublicRoute}. */
export const PUBLIC_ROUTE_KEY = Symbol.for('blackwing.api.public-route');

/**
 * Marks a controller or handler that needs no tenant: probes and the service banner. Everything not
 * marked is tenant-scoped, so a new route is closed by default (§8.6 fail closed).
 */
export const PublicRoute = (): MethodDecorator & ClassDecorator =>
  SetMetadata(PUBLIC_ROUTE_KEY, true);
