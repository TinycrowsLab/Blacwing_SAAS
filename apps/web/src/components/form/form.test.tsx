// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { Input } from '@blackwing/ui';

import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
  SubmitButton,
  mapServerErrorsToForm,
  useZodForm,
  type FormNotify,
} from './index';
import { ApiError } from '../../lib/api-error.js';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

const schema = z.object({
  name: z.string().min(3, 'Name must be at least 3 characters').max(20, 'Name is too long'),
  email: z.email('Enter a valid email'),
});
type Values = z.input<typeof schema>;

interface HarnessProps {
  readonly onSubmit?: (values: Values) => Promise<void> | void;
  readonly notify?: FormNotify;
  readonly onValidationFail?: (name: string) => void;
  readonly onRefetch?: () => void;
  readonly onForm?: (form: ReturnType<typeof useZodForm<typeof schema>>) => void;
}

function Harness({
  onSubmit = () => undefined,
  notify,
  onValidationFail,
  onRefetch,
  onForm,
}: HarnessProps) {
  const form = useZodForm(schema, { defaultValues: { name: '', email: '' } });
  onForm?.(form);
  return (
    <Form
      form={form}
      name="demo"
      onSubmit={onSubmit}
      {...(notify ? { notify } : {})}
      {...(onValidationFail ? { onValidationFail } : {})}
      {...(onRefetch ? { onRefetch } : {})}
    >
      <FormField
        control={form.control}
        name="name"
        render={({ field }) => (
          <FormItem>
            <FormLabel>Name</FormLabel>
            <FormControl>
              <Input {...field} />
            </FormControl>
            <FormDescription>Shown to your team.</FormDescription>
            <FormMessage />
          </FormItem>
        )}
      />
      <FormField
        control={form.control}
        name="email"
        render={({ field }) => (
          <FormItem>
            <FormLabel>Email</FormLabel>
            <FormControl>
              <Input {...field} />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />
      <SubmitButton pendingLabel="Saving">Save</SubmitButton>
      <a href="/scoping/next">Leave page</a>
    </Form>
  );
}

afterEach(cleanup);

function button(name: string): HTMLButtonElement {
  return screen.getByRole<HTMLButtonElement>('button', { name });
}

function formElement(): HTMLFormElement {
  const form = screen.getByLabelText<HTMLInputElement>('Name').form;
  if (!form) throw new Error('input is not inside a form');
  return form;
}

async function fill(user: ReturnType<typeof userEvent.setup>, name: string, email: string) {
  await user.type(screen.getByLabelText('Name'), name);
  await user.type(screen.getByLabelText('Email'), email);
}

describe('useZodForm + Form', () => {
  it('blocks submit on invalid input and shows a11y-wired field errors', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    const onValidationFail = vi.fn();
    render(<Harness onSubmit={onSubmit} onValidationFail={onValidationFail} />);
    const name = screen.getByLabelText('Name');
    await user.type(name, 'ab');
    await user.tab();
    const message = await screen.findByText('Name must be at least 3 characters');
    expect(name.getAttribute('aria-invalid')).toBe('true');
    const described = name.getAttribute('aria-describedby') ?? '';
    expect(described.split(' ')).toContain(message.id);
    expect(described.split(' ')).toHaveLength(2);
    expect(message.getAttribute('aria-live')).toBe('polite');
    expect(screen.getByText('Shown to your team.').id).toBe(described.split(' ')[0]);

    // A known error disables the button; a forced submit (Enter, scripts) is still blocked.
    expect(button('Save').disabled).toBe(true);
    await user.type(screen.getByLabelText('Email'), 'nope');
    fireEvent.submit(formElement());
    expect(onSubmit).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(onValidationFail).toHaveBeenCalledWith('demo');
    });
    expect(await screen.findByText('Enter a valid email')).toBeTruthy();
  });

  it('has no axe violations, valid or invalid', async () => {
    const user = userEvent.setup();
    const { container } = render(<Harness />);
    expect((await axe.run(container)).violations).toEqual([]);
    await user.type(screen.getByLabelText('Name'), 'a');
    await user.tab();
    await screen.findByText('Name must be at least 3 characters');
    expect((await axe.run(container)).violations).toEqual([]);
  });

  it('enforces schema length limits on very long unicode input', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.type(screen.getByLabelText('Name'), '😀'.repeat(25));
    await user.tab();
    expect(await screen.findByText('Name is too long')).toBeTruthy();
  });

  it('submits parsed values once valid and disables the button while pending', async () => {
    const user = userEvent.setup();
    let release: () => void = () => undefined;
    const onSubmit = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    render(<Harness onSubmit={onSubmit} />);
    expect(button('Save').disabled).toBe(false);
    await fill(user, 'Alice', 'a@example.com');
    await waitFor(() => {
      expect(button('Save').disabled).toBe(false);
    });
    await user.click(button('Save'));
    await waitFor(() => {
      expect(button('Saving').disabled).toBe(true);
    });
    expect(screen.getByRole('button', { name: 'Saving' }).getAttribute('aria-busy')).toBe('true');
    // A second submit while pending (Enter key) must not fire again.
    fireEvent.submit(formElement());
    fireEvent.submit(formElement());
    expect(onSubmit).toHaveBeenCalledTimes(1);
    release();
    await waitFor(() => {
      expect(button('Save').disabled).toBe(false);
    });
    expect(onSubmit).toHaveBeenCalledWith({ name: 'Alice', email: 'a@example.com' });
  });

  it('exposes isDirty and clears it after a successful submit', async () => {
    const user = userEvent.setup();
    let latest: ReturnType<typeof useZodForm<typeof schema>> | undefined;
    render(
      <Harness
        onForm={(f) => {
          latest = f;
        }}
      />,
    );
    expect(latest?.formState.isDirty).toBe(false);
    await fill(user, 'Alice', 'a@example.com');
    expect(latest?.formState.isDirty).toBe(true);
    await waitFor(() => {
      expect(button('Save').disabled).toBe(false);
    });
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(latest?.formState.isDirty).toBe(false);
    });
    expect(screen.getByLabelText<HTMLInputElement>('Name').value).toBe('Alice');
  });

  it('maps a 422 from submit to the right field and keeps the input', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn(() => {
      throw new ApiError({
        status: 422,
        code: 'validation_failed',
        title: 'Validation failed',
        fieldErrors: [{ path: 'email', message: 'Email already in use', code: 'taken' }],
      });
    });
    render(<Harness onSubmit={onSubmit} />);
    await fill(user, 'Alice', 'a@example.com');
    await waitFor(() => {
      expect(button('Save').disabled).toBe(false);
    });
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Email already in use')).toBeTruthy();
    expect(screen.getByLabelText('Email').getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByLabelText<HTMLInputElement>('Email').value).toBe('a@example.com');
  });

  it('keeps input and offers Retry on a network failure', async () => {
    const user = userEvent.setup();
    const notify = vi.fn();
    const onSubmit = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValue(undefined);
    render(<Harness onSubmit={onSubmit} notify={notify} />);
    await fill(user, 'Alice', 'a@example.com');
    await waitFor(() => {
      expect(button('Save').disabled).toBe(false);
    });
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(notify).toHaveBeenCalledTimes(1);
    });
    const note = notify.mock.calls[0]?.[0] as Parameters<FormNotify>[0];
    expect(note.action?.label).toBe('Retry');
    expect(JSON.stringify(note)).not.toContain('Alice');
    expect(screen.getByLabelText<HTMLInputElement>('Name').value).toBe('Alice');
    note.action?.run();
    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledTimes(2);
    });
  });

  it('surfaces a 412 as a conflict with a refetch action', async () => {
    const user = userEvent.setup();
    const notify = vi.fn();
    const onRefetch = vi.fn();
    const onSubmit = vi.fn(() => {
      throw new ApiError({
        status: 412,
        code: 'precondition_failed',
        title: 'Precondition failed',
      });
    });
    render(<Harness onSubmit={onSubmit} notify={notify} onRefetch={onRefetch} />);
    await fill(user, 'Alice', 'a@example.com');
    await waitFor(() => {
      expect(button('Save').disabled).toBe(false);
    });
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(notify).toHaveBeenCalled();
    });
    const note = notify.mock.calls[0]?.[0] as Parameters<FormNotify>[0];
    expect(note.title).toBe('Changed elsewhere');
    note.action?.run();
    expect(onRefetch).toHaveBeenCalledTimes(1);
  });

  it('holds an in-app navigation while there are unsaved edits, and Cancel keeps them', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await fill(user, 'Alice', 'a@example.com');
    fireEvent.click(screen.getByRole('link', { name: 'Leave page' }));
    expect(await screen.findByRole('dialog', { name: 'Discard unsaved changes?' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByLabelText<HTMLInputElement>('Name').value).toBe('Alice');
  });

  it('does not hold navigation once a successful save has cleared the dirty state', async () => {
    const user = userEvent.setup();
    let latest: ReturnType<typeof useZodForm<typeof schema>> | undefined;
    const onSubmit = vi.fn();
    render(
      <Harness
        onSubmit={onSubmit}
        onForm={(f) => {
          latest = f;
        }}
      />,
    );
    await fill(user, 'Alice', 'a@example.com');
    await waitFor(() => {
      expect(button('Save').disabled).toBe(false);
    });
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(latest?.formState.isDirty).toBe(false);
    });
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(fireEvent.click(screen.getByRole('link', { name: 'Leave page' }))).toBe(true);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('mapServerErrorsToForm', () => {
  function capture() {
    let form: ReturnType<typeof useZodForm<typeof schema>> | undefined;
    render(
      <Harness
        onForm={(f) => {
          form = f;
        }}
      />,
    );
    if (!form) throw new Error('form not captured');
    return form;
  }

  it('sets one error per violation on the matching fields', () => {
    const form = capture();
    const setError = vi.spyOn(form, 'setError');
    const count = mapServerErrorsToForm(
      new ApiError({
        status: 422,
        code: 'validation_failed',
        title: 'Validation failed',
        fieldErrors: [
          { path: 'name', message: 'Name reserved', code: 'reserved' },
          { path: 'email', message: 'Email blocked', code: 'blocked' },
        ],
      }),
      form,
    );
    expect(count).toBe(2);
    expect(setError).toHaveBeenCalledWith(
      'name',
      { type: 'reserved', message: 'Name reserved' },
      expect.anything(),
    );
    expect(setError).toHaveBeenCalledWith(
      'email',
      { type: 'blocked', message: 'Email blocked' },
      expect.anything(),
    );
  });

  it('turns a violation on an unknown field into a form-level error instead of dropping it', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn(() => {
      throw new ApiError({
        status: 422,
        code: 'validation_failed',
        title: 'Validation failed',
        fieldErrors: [{ path: 'scope.rules[0].value', message: 'Bad rule', code: 'bad' }],
      });
    });
    render(<Harness onSubmit={onSubmit} />);
    await fill(user, 'Alice', 'a@example.com');
    await waitFor(() => {
      expect(button('Save').disabled).toBe(false);
    });
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('scope.rules.0.value: Bad rule')).toBeTruthy();
  });

  it('shows a toast for an error without field violations', () => {
    const form = capture();
    const notify = vi.fn();
    const count = mapServerErrorsToForm(
      new ApiError({ status: 500, code: 'internal', title: 'Internal error', detail: 'Try later' }),
      form,
      { notify },
    );
    expect(count).toBe(0);
    expect(notify).toHaveBeenCalledWith({
      title: 'Internal error',
      description: 'Try later',
      variant: 'destructive',
    });
  });
});
