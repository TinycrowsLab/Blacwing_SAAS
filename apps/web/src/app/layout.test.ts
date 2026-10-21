import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const src = (f: string): string => readFileSync(resolve(process.cwd(), 'src/app', f), 'utf8');

describe('root layout theming wiring', () => {
  it('puts suppressHydrationWarning on <html>, not <body>', () => {
    const layout = src('layout.tsx');
    expect(layout).toMatch(/<html lang="en" suppressHydrationWarning>/);
    expect(layout).not.toMatch(/<body[^>]*suppressHydrationWarning/);
  });
  it('mounts ThemeProvider in providers.tsx and does not hand-roll a localStorage reader', () => {
    const providers = src('providers.tsx');
    expect(providers).toContain('<ThemeProvider>');
    expect(providers + src('layout.tsx')).not.toContain('localStorage');
  });
});
