// Browser stand-in for `node:url`, used only by the client bundle (see next.config.mjs).
// @blackwing/contracts imports domainToASCII for its scope matcher; the console never calls it.
export function domainToASCII(domain: string): string {
  try {
    return new URL(`http://${domain}`).hostname;
  } catch {
    return '';
  }
}
