/** DI token of the {@link MemberReadStore} the GraphQL resolvers read through (API-009). */
export const GRAPHQL_MEMBER_STORE = Symbol.for('blackwing.api.graphql.member-store');

/** DI token of the GraphQL metrics (`graphql_requests_total`, `graphql_complexity`, `graphql_rejected_total`). */
export const GRAPHQL_METRICS = Symbol.for('blackwing.api.graphql.metrics');
