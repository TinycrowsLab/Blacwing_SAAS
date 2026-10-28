import { parse, print } from 'graphql';

/**
 * A persisted-query id: the lowercase hex SHA-256 of the canonical query text (API-GQL-PERSIST, CONTEXT_PACK §9).
 * Anything else, uppercase hex included, is not an id and never matches a manifest entry.
 */
export const PERSISTED_HASH_PATTERN = /^[0-9a-f]{64}$/;

/**
 * The one normalization every persisted-query hash is computed over: the document printed from its AST, so
 * whitespace, comments and line breaks never change the id. The browser client and the API both call this, so
 * a hash computed on one side matches the manifest entry the other side wrote. A document that does not parse
 * throws the parser's `GraphQLError`.
 */
export function canonicalQueryText(text: string): string {
  return print(parse(text));
}
