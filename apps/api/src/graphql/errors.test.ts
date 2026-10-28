import { HttpException, HttpStatus } from '@nestjs/common';
import { GraphQLError } from 'graphql';
import { describe, expect, it } from 'vitest';

import { AuthError, InternalError, RateLimitedError, ValidationError } from '@blackwing/errors';

import { formatGraphqlErrors, registerGraphqlProblemCodes } from './errors.js';
import { QUERY_TOO_COMPLEX } from './limits.js';
import { createProblemRegistry } from '../errors/registry.js';

const registry = createProblemRegistry();
registerGraphqlProblemCodes(registry);

function render(error: GraphQLError, data: unknown = null) {
  return formatGraphqlErrors({ data: data as never, errors: [error] }, registry);
}

function onlyError(response: ReturnType<typeof render>) {
  const [error] = response.response.errors;
  if (error === undefined) throw new Error('no error rendered');
  return error;
}

describe('formatGraphqlErrors', () => {
  it('maps an AppError to its registry code and keeps a client-safe message', () => {
    const error = onlyError(
      render(new GraphQLError('x', { originalError: new AuthError('no authenticated principal') })),
    );
    expect(error.extensions).toMatchObject({ code: 'unauthenticated' });
    expect(error.message).toBe('no authenticated principal');
  });

  it('keeps the message of a 4xx AppError and replaces the message of a 5xx one', () => {
    const client = onlyError(
      render(new GraphQLError('x', { originalError: new ValidationError('first must be 1-200') })),
    );
    expect(client).toMatchObject({
      message: 'first must be 1-200',
      extensions: { code: 'validation_failed' },
    });
    const server = onlyError(
      render(
        new GraphQLError('x', {
          originalError: new InternalError('connection to 10.0.0.5 reset'),
        }),
      ),
    );
    expect(server.message).toBe('Internal server error');
    expect(server.extensions).toMatchObject({ code: 'internal_error' });
  });

  it('maps a rate-limit denial to rate_limited', () => {
    const error = onlyError(
      render(new GraphQLError('x', { originalError: new RateLimitedError('slow down') })),
    );
    expect(error.extensions).toMatchObject({ code: 'rate_limited' });
  });

  it('never renders the message or stack of an unexpected thrown value', () => {
    const cause = new Error('password=hunter2 at /srv/app/secret.ts:12');
    const error = onlyError(render(new GraphQLError('x', { originalError: cause })));
    expect(error).toMatchObject({
      message: 'Internal server error',
      extensions: { code: 'internal_error' },
    });
    expect(JSON.stringify(error)).not.toMatch(/hunter2|secret\.ts|stack/);
  });

  it('maps an HTTP exception by its status', () => {
    const error = onlyError(
      render(
        new GraphQLError('x', { originalError: new HttpException('nope', HttpStatus.FORBIDDEN) }),
      ),
    );
    expect(error.extensions).toMatchObject({ code: 'permission_denied' });
  });

  it('keeps the code of a limit rejection and of a plain validation error', () => {
    const tooComplex = onlyError(
      render(
        new GraphQLError('query depth 4 exceeds the limit of 3', {
          extensions: { code: QUERY_TOO_COMPLEX },
        }),
      ),
    );
    expect(tooComplex).toMatchObject({ extensions: { code: QUERY_TOO_COMPLEX } });
    const plain = onlyError(render(new GraphQLError('Cannot query field "nope" on type "Query".')));
    expect(plain).toMatchObject({ extensions: { code: 'validation_failed' } });
  });

  it('keeps data of a partial failure and lists the failing path', () => {
    const failing = new GraphQLError('x', {
      originalError: new InternalError('db down'),
      path: ['tenantMembers', 1, 'user'],
    });
    const response = formatGraphqlErrors(
      {
        data: {
          tenantMembers: [
            { userId: 'usr_1', user: null },
            { userId: 'usr_2', user: null },
          ],
        },
        errors: [failing],
      },
      registry,
    );
    expect(response.statusCode).toBe(200);
    expect(response.response.data).toEqual({
      tenantMembers: [
        { userId: 'usr_1', user: null },
        { userId: 'usr_2', user: null },
      ],
    });
    expect(response.response.errors[0]?.path).toEqual(['tenantMembers', 1, 'user']);
  });

  it('returns null data when nothing resolved', () => {
    expect(
      render(new GraphQLError('x', { originalError: new AuthError() })).response.data,
    ).toBeNull();
  });
});

describe('registerGraphqlProblemCodes', () => {
  it('registers query_too_complex once and tolerates repeated registration', () => {
    const local = createProblemRegistry();
    registerGraphqlProblemCodes(local);
    registerGraphqlProblemCodes(local);
    expect(local.get(QUERY_TOO_COMPLEX)).toEqual({
      status: 400,
      title: 'Query too complex',
      typeSuffix: QUERY_TOO_COMPLEX,
    });
  });
});
