import { ConnectorUnknownProviderError, ConnectorValidationError } from './errors.js';

import type { TicketConnector } from './types.js';

/** Maps a provider name to its connector. */
export interface ConnectorRegistry {
  /** Registers `connector` for `provider`. A provider can be registered once; a second registration is refused. */
  register(provider: string, connector: TicketConnector): void;
  /** Returns the connector for `provider`, or throws `CONNECTOR_UNKNOWN_PROVIDER`. */
  get(provider: string): TicketConnector;
}

/** A new, empty registry. Tests use their own instance; production code uses {@link connectorRegistry}. */
export function createConnectorRegistry(): ConnectorRegistry {
  const connectors = new Map<string, TicketConnector>();
  return {
    register(provider, connector) {
      if (connectors.has(provider))
        throw new ConnectorValidationError(
          'A ticket connector is already registered for this provider',
        );
      connectors.set(provider, connector);
    },
    get(provider) {
      const connector = connectors.get(provider);
      if (connector === undefined)
        throw new ConnectorUnknownProviderError('Unknown ticket connector provider');
      return connector;
    },
  };
}

/** The process-wide registry that concrete connectors register into. */
export const connectorRegistry: ConnectorRegistry = createConnectorRegistry();
