/** DI token of the {@link MemberReadStore} the GraphQL resolvers read through (API-009). */
export const GRAPHQL_MEMBER_STORE = Symbol.for('blackwing.api.graphql.member-store');

/** DI token of the GraphQL metrics (`graphql_requests_total`, `graphql_complexity`, `graphql_rejected_total`). */
export const GRAPHQL_METRICS = Symbol.for('blackwing.api.graphql.metrics');

/** DI token of the {@link AssessmentReadStore} the assessment-request resolvers read through (SCOPE-001). */
export const GRAPHQL_ASSESSMENT_STORE = Symbol.for('blackwing.api.graphql.assessment-store');

/** DI token of the {@link SurfaceReadStore} the surface resolvers read through (GRAPH-004 / GRAPH-009). */
export const GRAPHQL_SURFACE_STORE = Symbol.for('blackwing.api.graphql.surface-store');
