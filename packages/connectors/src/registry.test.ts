import { describe, expect, it } from 'vitest';

import { AppError } from '@blackwing/errors';

import { ConnectorUnknownProviderError, ConnectorValidationError } from './errors.js';
import { FakeConnector } from './fake.js';
import { connectorRegistry, createConnectorRegistry } from './registry.js';

describe('connector registry', () => {
  it('returns the connector registered for a provider', () => {
    const registry = createConnectorRegistry();
    const connector = new FakeConnector();
    registry.register('jira', connector);
    expect(registry.get('jira')).toBe(connector);
  });

  it('refuses an unknown provider with CONNECTOR_UNKNOWN_PROVIDER', () => {
    const registry = createConnectorRegistry();
    expect(() => {
      registry.get('servicenow');
    }).toThrow(ConnectorUnknownProviderError);
    expect(() => {
      registry.get('servicenow');
    }).toThrow(AppError);
  });

  it.each(['__proto__', 'constructor', 'toString', ''])(
    'treats the prototype-like or empty name %j as unknown',
    (provider) => {
      const registry = createConnectorRegistry();
      expect(() => registry.get(provider)).toThrow(ConnectorUnknownProviderError);
    },
  );

  it('refuses a second registration for the same provider instead of replacing the connector', () => {
    const registry = createConnectorRegistry();
    const first = new FakeConnector();
    registry.register('github', first);
    expect(() => {
      registry.register('github', new FakeConnector());
    }).toThrow(ConnectorValidationError);
    expect(registry.get('github')).toBe(first);
  });

  it('keeps separate registries independent of each other', () => {
    const left = createConnectorRegistry();
    left.register('gitlab', new FakeConnector());
    const right = createConnectorRegistry();
    expect(() => right.get('gitlab')).toThrow(ConnectorUnknownProviderError);
  });

  it('exposes a process-wide registry that starts empty for unknown providers', () => {
    expect(() => connectorRegistry.get('no-such-provider')).toThrow(ConnectorUnknownProviderError);
  });
});
