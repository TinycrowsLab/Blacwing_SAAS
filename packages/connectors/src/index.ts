/** Workspace package name of this package. */
export const name = '@blackwing/connectors';

/** Package version; kept in sync with package.json. */
export const version = '0.0.0';

export {
  ConnectorAuthFailedError,
  ConnectorNotFoundError,
  ConnectorRateLimitedError,
  type ConnectorRateLimitedErrorOptions,
  ConnectorUnknownProviderError,
  ConnectorUpstreamError,
  ConnectorValidationError,
} from './errors.js';
export { FAKE_PROVIDER, FakeConnector } from './fake.js';
export {
  CONNECTOR_OPERATIONS,
  type ConnectorOperation,
  connectorMetricLabels,
  connectorSpanName,
} from './observability.js';
export { connectorRegistry, type ConnectorRegistry, createConnectorRegistry } from './registry.js';
export {
  type ConnectionTestResult,
  type ResolvedConnectorConfig,
  TICKET_LIMITS,
  type TicketConnector,
  type TicketPatch,
  ticketPatchSchema,
  type TicketPayload,
  ticketPayloadSchema,
  type TicketRef,
  type TicketStatus,
  ticketStatusSchema,
  type WebhookEvent,
  type WebhookHeaders,
} from './types.js';
