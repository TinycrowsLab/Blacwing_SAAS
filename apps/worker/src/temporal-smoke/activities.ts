/** Trivial activity for the DEVENV-007 smoke test. It is not a product activity. */
export function greet(name: string): Promise<string> {
  return Promise.resolve(`hello ${name}`);
}
