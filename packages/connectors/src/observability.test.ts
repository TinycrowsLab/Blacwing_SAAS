import { describe, expect, it } from 'vitest';

import { CONNECTOR_OPERATIONS, connectorMetricLabels, connectorSpanName } from './observability.js';

describe('connector observability names', () => {
  it('names one span per operation', () => {
    expect(CONNECTOR_OPERATIONS.map((operation) => connectorSpanName(operation))).toEqual([
      'connector.testConnection',
      'connector.createTicket',
      'connector.updateTicket',
      'connector.getTicket',
      'connector.verifyWebhook',
    ]);
  });

  it('labels metrics by provider and operation only', () => {
    expect(connectorMetricLabels('jira', 'createTicket')).toEqual({
      provider: 'jira',
      operation: 'createTicket',
    });
  });
});
