'use client';

import * as Popover from '@radix-ui/react-popover';
import { CircleHelp } from 'lucide-react';
import * as React from 'react';

import { cn } from '../../lib/cn';
import { Button } from '../button';
import { HELP_TOPICS, type HelpTopicId } from './help-topics';
import { resolveDocsLink } from './resolve-docs-link';

export interface HelpPopoverProps {
  topic: HelpTopicId;
  /** Guide origin or same-origin path (see `resolveDocsLink`). */
  docsBaseUrl: string;
  /** Guide version segment. Pinned per release so links keep matching the docs they were written for. */
  docsVersion: string;
  /** Called when the popover opens. The console maps it to `help_popover_opened_total{topic}`. */
  onOpen?: ((topic: HelpTopicId) => void) | undefined;
  className?: string | undefined;
}

/**
 * Icon button that opens a short explanation of one concept, with a deep link to the versioned guide.
 * The summary is always rendered inline, so an unreachable guide only loses the link (no blank popover).
 */
export function HelpPopover({
  topic,
  docsBaseUrl,
  docsVersion,
  onOpen,
  className,
}: HelpPopoverProps) {
  const entry = HELP_TOPICS[topic];
  const href = resolveDocsLink({
    baseUrl: docsBaseUrl,
    version: docsVersion,
    page: entry.page,
    anchor: entry.anchor,
  });

  return (
    <Popover.Root
      onOpenChange={(open) => {
        if (open) onOpen?.(topic);
      }}
    >
      <Popover.Trigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={`Help: ${entry.title}`}
          className={cn('h-6 w-6 rounded-full text-muted-foreground', className)}
          data-help-topic={topic}
        >
          <CircleHelp className="h-4 w-4" aria-hidden="true" />
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          sideOffset={6}
          collisionPadding={12}
          className="z-50 w-72 rounded-md border border-border bg-popover p-4 text-sm text-popover-foreground shadow-md"
        >
          <h3 className="text-sm font-semibold">{entry.title}</h3>
          <p className="mt-2 text-muted-foreground">{entry.summary}</p>
          {href !== null && (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-3 inline-block text-sm font-medium text-primary underline-offset-4 hover:underline"
            >
              Read the full guide
            </a>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
