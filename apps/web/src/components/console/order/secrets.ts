// Test-account values typed on the plan. The API never returns them, so an edit that re-creates the request needs
// them from here. In memory only: never in storage, never in the URL.
// shortcut: lost on reload (the plan then asks for the values again before another edit). Upgrade when the API gains
// PATCH /requests/:id, which keeps them server-side.
export interface AccountValue {
  readonly role: string;
  readonly headerName: string;
  readonly headerValue: string;
}

const byRequest = new Map<string, readonly AccountValue[]>();

export const rememberAccounts = (requestId: string, accounts: readonly AccountValue[]): void => {
  byRequest.set(requestId, accounts);
};

export const recallAccounts = (requestId: string): readonly AccountValue[] | undefined => byRequest.get(requestId);
