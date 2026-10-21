/// <reference types="vite/client" />
// @vitest-environment jsdom
import { composeStories } from '@storybook/react';
import { cleanup } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * Storybook component tests (issue #271). Every `*.stories.tsx` is composed and rendered in light and
 * dark, its `play` interaction runs, and axe reports no serious or critical violations. The same
 * stories are browsed in Storybook (`pnpm --filter @blackwing/ui storybook`) with the a11y addon.
 */

// jsdom has no ResizeObserver; Radix popper (dropdown, tooltip, select) needs one to position content.
class ResizeObserverStub {
  observe(): void {
    return undefined;
  }
  unobserve(): void {
    return undefined;
  }
  disconnect(): void {
    return undefined;
  }
}
if (!('ResizeObserver' in globalThis)) {
  Object.defineProperty(globalThis, 'ResizeObserver', { value: ResizeObserverStub });
}

type StoryModule = Parameters<typeof composeStories>[0];

/** The part of a composed story this suite drives: `run()` mounts it and executes its `play`. */
interface ComposedStory {
  run(options: { canvasElement: HTMLElement }): Promise<unknown>;
}

/** A composed story is a React component (a function) that also carries `run()`. */
const isComposedStory = (value: unknown): value is ComposedStory =>
  (typeof value === 'function' || (typeof value === 'object' && value !== null)) &&
  'run' in value &&
  typeof value.run === 'function';

const modules = import.meta.glob<StoryModule>('./components/*.stories.tsx', { eager: true });
const primitives = import.meta.glob('./components/*.tsx', { eager: false });

const cases = Object.entries(modules).flatMap(([file, mod]) =>
  Object.entries(composeStories(mod)).map(([name, story]) => {
    if (!isComposedStory(story)) throw new Error(`${file}: export "${name}" is not a story`);
    return { label: `${file.replace('./components/', '')} ${name}`, Story: story };
  }),
);

afterEach(cleanup);

describe('story coverage', () => {
  it('has a stories file for every primitive in src/components', () => {
    const storyFiles = new Set(Object.keys(modules));
    const missing = Object.keys(primitives)
      .filter((file) => !file.endsWith('.stories.tsx'))
      .map((file) => file.replace(/\.tsx$/, '.stories.tsx'))
      .filter((file) => !storyFiles.has(file));
    expect(missing).toEqual([]);
  });

  it('every stories file exports at least one story', () => {
    const empty = Object.entries(modules)
      .filter(([, mod]) => Object.keys(composeStories(mod)).length === 0)
      .map(([file]) => file);
    expect(empty).toEqual([]);
  });
});

describe.each(['light', 'dark'] as const)('stories in %s theme', (theme) => {
  for (const { label, Story } of cases) {
    it(`${label} renders, passes its interaction and has no serious a11y violations`, async () => {
      // run() mounts the story into this canvas. The `.dark` class sits on an ancestor so the token
      // overrides in tokens.css apply to the whole story. Storybook unmounts the previous story (and
      // its portals) at the start of the next run, so the canvas is left attached.
      const canvas = document.createElement('div');
      canvas.className = theme === 'dark' ? 'dark' : '';
      document.body.append(canvas);

      await Story.run({ canvasElement: canvas });
      // Dialog and Sheet portal to body, so an open one counts as rendered too.
      expect(
        canvas.childElementCount > 0 || document.querySelector('[role="dialog"]') !== null,
      ).toBe(true);

      const { violations } = await axe.run(document.body, {
        // Contrast needs real layout and computed colours, which jsdom does not provide. The a11y
        // addon in Storybook checks contrast in a browser.
        rules: { 'color-contrast': { enabled: false } },
      });
      const serious = violations.filter(
        (violation) => violation.impact === 'serious' || violation.impact === 'critical',
      );
      expect(serious.map((violation) => `${violation.id}: ${violation.help}`)).toEqual([]);
    });
  }
});
