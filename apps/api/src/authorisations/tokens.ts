/** DI token of the standing-authorisation service the controller uses. */
export const AUTHORISATION_SERVICE = Symbol.for('blackwing.api.authorisations.service');
/** DI token of the source of the step-up evidence (the validated token's `acr` and `auth_time`) for a request. */
export const AUTHORISATION_EVIDENCE = Symbol.for('blackwing.api.authorisations.evidence');
