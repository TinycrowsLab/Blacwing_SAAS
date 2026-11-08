import { describe, expect, it } from 'vitest';

import {
  proposeWorkspaceName,
  registrableLabel,
  tidyWorkspaceName,
  workspaceNameError,
} from './workspace-name';

describe('workspace name', () => {
  it('proposes the company from the hd claim or the e-mail domain', () => {
    expect(proposeWorkspaceName({ email: 'jatin@tinycrows.com' })).toEqual({
      name: 'Tinycrows',
      domain: 'tinycrows.com',
    });
    expect(proposeWorkspaceName({ email: 'a@mail.example.co.uk' }).name).toBe('Example');
    expect(proposeWorkspaceName({ email: 'a@x.com', hd: 'blue-river.io' })).toEqual({
      name: 'Blue River',
      domain: 'blue-river.io',
    });
  });

  it("proposes the person's workspace for a consumer address", () => {
    expect(proposeWorkspaceName({ email: 'jatin@gmail.com', givenName: 'Jatin' })).toEqual({
      name: "Jatin's workspace",
      domain: null,
    });
    expect(proposeWorkspaceName({ email: 'sam.lee@outlook.com' }).name).toBe("Sam.lee's workspace");
  });

  it('finds the registrable label', () => {
    expect(registrableLabel('tinycrows.com')).toBe('tinycrows');
    expect(registrableLabel('a.b.example.com.au')).toBe('example');
  });

  it('validates 2 to 60 characters after trimming', () => {
    expect(workspaceNameError(' Tinycrows ')).toBeNull();
    expect(workspaceNameError(' a ')).toBe('A name needs at least 2 characters.');
    expect(workspaceNameError('x'.repeat(61))).toBe('Keep it under 60 characters.');
    expect(workspaceNameError('😀')).toBe('A name needs at least 2 characters.');
    expect(tidyWorkspaceName('  NCU   India  ')).toBe('NCU India');
  });
});
