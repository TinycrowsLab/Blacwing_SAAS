import type { FieldPath, FieldValues, Resolver } from 'react-hook-form';

/** Returns an error message, or `undefined` when the value is acceptable. Must honour `signal`. */
export type AsyncValidator<TValue> = (
  value: TValue,
  context: { readonly signal: AbortSignal },
) => Promise<string | undefined>;

export type AsyncValidators<TInput extends FieldValues> = Readonly<
  Partial<Record<FieldPath<TInput>, AsyncValidator<unknown>>>
>;

/** Default pause after the last keystroke before a check is sent. */
const DEFAULT_ASYNC_DEBOUNCE_MS = 300;

function readPath(values: unknown, path: string): unknown {
  let cursor: unknown = values;
  for (const key of path.split('.')) {
    if (typeof cursor !== 'object' || cursor === null) return undefined;
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return cursor;
}

/** `signal.aborted` read through a call, so it is not narrowed across an `await`. */
function isAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

/**
 * Resolver extension for async checks. The schema resolver always runs first and a field with a
 * schema error is never sent to the server. A newer validation of the same field aborts the
 * older one (debounce + `AbortSignal`), and the stale call reports only the schema result so an
 * out-of-date answer can never mark a field invalid. A validator that throws (network failure)
 * fails open here: the server re-validates on submit.
 */
export function withAsyncValidators<TInput extends FieldValues, TContext, TOutput>(
  base: Resolver<TInput, TContext, TOutput>,
  validators: AsyncValidators<TInput>,
  debounceMs: number = DEFAULT_ASYNC_DEBOUNCE_MS,
): Resolver<TInput, TContext, TOutput> {
  const inflight = new Map<string, AbortController>();
  return async (values, context, options) => {
    const result = await base(values, context, options);
    const targets = options.names ?? Object.keys(validators);
    const checks = Object.entries(validators).filter(
      ([name]) => targets.includes(name as never) && readPath(result.errors, name) === undefined,
    );
    if (checks.length === 0) return result;
    const errors: Record<string, { type: string; message: string }> = {};
    const outcome = { stale: false };
    await Promise.all(
      checks.map(async ([name, validate]) => {
        inflight.get(name)?.abort();
        const controller = new AbortController();
        inflight.set(name, controller);
        await sleep(debounceMs, controller.signal);
        if (isAborted(controller.signal)) {
          outcome.stale = true;
          return;
        }
        try {
          const message = await (validate as AsyncValidator<unknown>)(readPath(values, name), {
            signal: controller.signal,
          });
          if (isAborted(controller.signal)) outcome.stale = true;
          else if (message) errors[name] = { type: 'async', message };
        } catch {
          // Aborted or network failure: leave the schema verdict alone.
        } finally {
          if (inflight.get(name) === controller) inflight.delete(name);
        }
      }),
    );
    if (outcome.stale || Object.keys(errors).length === 0) return result;
    return { values: {}, errors: { ...result.errors, ...errors } } as never;
  };
}
