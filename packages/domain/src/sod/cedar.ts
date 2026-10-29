/**
 * The Cedar condition for separation of duties (#352, §8.4). RBAC-004 and POLICY embed it in `forbid` policies on
 * an action whose resource carries `requesterId`, for example:
 * `forbid (principal, action, resource) when { ${sodCedarCondition()} };`
 * The shared vectors in `vectors.ts` prove that this condition agrees with {@link assertDifferentActors}.
 */
export function sodCedarCondition(): string {
  return 'resource.requesterId == principal.id';
}
