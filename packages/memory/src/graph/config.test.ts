import { describe, expect, it } from 'vitest';

import { ConfigValidationError } from '@blackwing/config';
import { AppError } from '@blackwing/errors';

import { loadNeo4jConfig } from './config.js';

const VALID = {
  NEO4J_URI: 'bolt://graph.internal:7687',
  NEO4J_PASSWORD: 'correct-horse-battery',
};

function catchError(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected a throw');
}

describe('loadNeo4jConfig', () => {
  it('applies the documented defaults and freezes the result', () => {
    const config = loadNeo4jConfig(VALID);
    expect(config).toEqual({
      uri: 'bolt://graph.internal:7687',
      username: 'neo4j',
      password: 'correct-horse-battery',
      database: 'neo4j',
      maxPoolSize: 50,
      connectionTimeoutMs: 5000,
      maxTxRetryMs: 15000,
    });
    expect(Object.isFrozen(config)).toBe(true);
  });

  it('reads database, pool size and username when set', () => {
    const config = loadNeo4jConfig({
      ...VALID,
      NEO4J_DATABASE: 'surface',
      NEO4J_MAX_POOL_SIZE: '120',
      NEO4J_USER: 'svc',
    });
    expect(config).toMatchObject({ database: 'surface', maxPoolSize: 120, username: 'svc' });
  });

  it.each([
    'bolt://h:7687',
    'bolt+s://h:7687',
    'bolt+ssc://h:7687',
    'neo4j://h:7687',
    'neo4j+s://h:7687',
    'neo4j+ssc://h:7687',
  ])('accepts the scheme %s', (uri) => {
    expect(loadNeo4jConfig({ ...VALID, NEO4J_URI: uri }).uri).toBe(uri);
  });

  it.each(['http://h:7687', 'postgres://h:5432', 'redis://h:6379', 'h:7687', 'not a url'])(
    'rejects the unsupported URI %s at parse time',
    (uri) => {
      const error = catchError(() => loadNeo4jConfig({ ...VALID, NEO4J_URI: uri }));
      expect(error).toBeInstanceOf(ConfigValidationError);
      expect((error as ConfigValidationError).invalidKeys).toEqual(['NEO4J_URI']);
    },
  );

  it('rejects a URI that carries credentials, without echoing them', () => {
    const uri = 'bolt://neo4j:leaked-password@h:7687';
    const error = catchError(() => loadNeo4jConfig({ ...VALID, NEO4J_URI: uri }));
    expect(error).toBeInstanceOf(ConfigValidationError);
    expect((error as ConfigValidationError).invalidKeys).toEqual(['NEO4J_URI']);
    expect(String(error)).not.toContain('leaked-password');
    expect(JSON.stringify(error)).not.toContain('leaked-password');
  });

  it('fails with GRAPH_CONFIG_MISSING when NEO4J_URI is unset', () => {
    const error = catchError(() => loadNeo4jConfig({ NEO4J_PASSWORD: VALID.NEO4J_PASSWORD }));
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('GRAPH_CONFIG_MISSING');
    expect((error as AppError).message).toContain('NEO4J_URI');
  });

  it('treats an empty NEO4J_URI as missing', () => {
    const error = catchError(() => loadNeo4jConfig({ ...VALID, NEO4J_URI: '' }));
    expect((error as AppError).code).toBe('GRAPH_CONFIG_MISSING');
  });

  it('fails with GRAPH_CONFIG_MISSING when the password is unset, and never names its value', () => {
    const error = catchError(() => loadNeo4jConfig({ NEO4J_URI: VALID.NEO4J_URI }));
    expect((error as AppError).code).toBe('GRAPH_CONFIG_MISSING');
    expect((error as AppError).message).toContain('NEO4J_PASSWORD');
  });

  it.each(['0', '-3', 'abc', '1.5', '1001', ' 10'])(
    'rejects the pool size %j with a config error (fail closed)',
    (size) => {
      const error = catchError(() => loadNeo4jConfig({ ...VALID, NEO4J_MAX_POOL_SIZE: size }));
      expect(error).toBeInstanceOf(ConfigValidationError);
      expect((error as ConfigValidationError).invalidKeys).toEqual(['NEO4J_MAX_POOL_SIZE']);
    },
  );

  it('keeps the password out of the parsed error when another key is invalid', () => {
    const error = catchError(() =>
      loadNeo4jConfig({ ...VALID, NEO4J_URI: 'http://h', NEO4J_MAX_POOL_SIZE: '0' }),
    );
    expect(JSON.stringify(error)).not.toContain('correct-horse-battery');
  });
});
