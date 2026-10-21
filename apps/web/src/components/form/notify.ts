/** What the form helpers ask the console to show; wired to the toast system by the caller. */
export interface FormNotification {
  readonly title: string;
  readonly description?: string | undefined;
  readonly variant: 'default' | 'destructive';
  /** Optional single action, e.g. "Retry" or "Reload". */
  readonly action?: { readonly label: string; readonly run: () => void };
}

export type FormNotify = (notification: FormNotification) => void;
