import { AppError, type AppErrorOptions } from '@blackwing/errors';

/**
 * `GATE2_ILLEGAL_TRANSITION` (409): the Gate 2 state machine refused a transition (GATE2-001). `from`
 * and `event` are state and event names, which are safe to show the caller.
 */
export class IllegalGate2TransitionError extends AppError {
  declare readonly code: 'GATE2_ILLEGAL_TRANSITION';
  /** State the exception was in. */
  readonly from: string;
  /** Event that was refused. */
  readonly event: string;

  constructor(from: string, event: string, detail?: string, options: AppErrorOptions = {}) {
    super('GATE2_ILLEGAL_TRANSITION', `Illegal Gate 2 transition: ${from} on ${event}`, {
      detail: detail ?? `A Gate 2 exception in "${from}" cannot take the "${event}" event.`,
      ...options,
    });
    this.from = from;
    this.event = event;
  }
}

/**
 * `GATE2_ALREADY_DECIDED` (409): another decision (a person's, the timer's or a supersede) was
 * committed first. The caller reloads the exception; nothing was changed.
 */
export class Gate2AlreadyDecidedError extends AppError {
  declare readonly code: 'GATE2_ALREADY_DECIDED';
  /** State the exception is in now. */
  readonly state: string;

  constructor(state: string, options: AppErrorOptions = {}) {
    super('GATE2_ALREADY_DECIDED', 'Gate 2 exception already decided', {
      detail: `This exception is already "${state}".`,
      ...options,
    });
    this.state = state;
  }
}

/** `GATE2_SOD_VIOLATION` (403): the approver is the requester or the plan approver (§8.4). */
export class Gate2SeparationOfDutiesError extends AppError {
  declare readonly code: 'GATE2_SOD_VIOLATION';

  constructor(detail: string, options: AppErrorOptions = {}) {
    super('GATE2_SOD_VIOLATION', 'Gate 2 separation of duties violated', { detail, ...options });
  }
}

/** `GATE2_DESTRUCTIVE_FORBIDDEN` (403): a destructive exception can never be approved (§8.3). */
export class Gate2DestructiveForbiddenError extends AppError {
  declare readonly code: 'GATE2_DESTRUCTIVE_FORBIDDEN';

  constructor(options: AppErrorOptions = {}) {
    super('GATE2_DESTRUCTIVE_FORBIDDEN', 'Destructive actions cannot be approved', {
      detail: 'Destructive actions are blocked by the platform baseline and can never be approved.',
      ...options,
    });
  }
}
