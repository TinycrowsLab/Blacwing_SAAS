/** Every operation a ticket connector exposes. Span names and metric labels are built from these values only. */
export const CONNECTOR_OPERATIONS = [
  'testConnection',
  'createTicket',
  'updateTicket',
  'getTicket',
  'verifyWebhook',
] as const;
export type ConnectorOperation = (typeof CONNECTOR_OPERATIONS)[number];

/** Span name for one connector operation, for example `connector.createTicket`. */
export function connectorSpanName(operation: ConnectorOperation): string {
  return `connector.${operation}`;
}

/** Metric labels and span attributes for one connector operation. The provider is a registry key, never a secret. */
export function connectorMetricLabels(
  provider: string,
  operation: ConnectorOperation,
): { readonly provider: string; readonly operation: ConnectorOperation } {
  return { provider, operation };
}
