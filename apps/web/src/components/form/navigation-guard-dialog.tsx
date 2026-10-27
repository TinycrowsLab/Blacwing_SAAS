'use client';

import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@blackwing/ui';

import type { UnsavedChangesGuard } from './use-unsaved-changes-guard';

/** Confirm dialog for `useUnsavedChangesGuard`. Confirm leaves the page; Cancel (or Escape) stays. */
export function NavigationGuardDialog({ guard }: { readonly guard: UnsavedChangesGuard }) {
  return (
    <Dialog
      open={guard.open}
      onOpenChange={(open) => {
        if (!open) guard.cancel();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Discard unsaved changes?</DialogTitle>
          <DialogDescription>
            Leaving this page loses the changes you have not saved.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={guard.cancel}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={guard.confirm}>
            Discard changes
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
