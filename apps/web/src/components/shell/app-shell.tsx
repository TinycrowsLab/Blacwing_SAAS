'use client';

import { Menu, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import * as React from 'react';

import {
  Avatar,
  AvatarFallback,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuTrigger,
  ModeToggle,
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
  SheetTrigger,
} from '@blackwing/ui';

import { Breadcrumbs } from './breadcrumbs';
import { NavList } from './nav-list';

import type { ReactNode } from 'react';

/** localStorage key holding "1" when the desktop sidebar is collapsed. */
export const NAV_COLLAPSED_KEY = 'bw-nav-collapsed';

export interface AppShellProps {
  readonly user: { readonly id: string; readonly email: string; readonly name: string };
  readonly roles: readonly string[];
  readonly children: ReactNode;
}

function readCollapsed(): boolean {
  try {
    return window.localStorage.getItem(NAV_COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
}

/** Frame of every authenticated page: role-aware sidebar (drawer under `md`), topbar and content. */
export function AppShell({ user, roles, children }: AppShellProps): ReactNode {
  const label = user.name === '' ? user.email : user.name;
  const [collapsed, setCollapsed] = React.useState(false);
  const [drawerOpen, setDrawerOpen] = React.useState(false);
  React.useEffect(() => {
    setCollapsed(readCollapsed());
  }, []);
  const toggleCollapsed = (): void => {
    const next = !collapsed;
    setCollapsed(next);
    try {
      window.localStorage.setItem(NAV_COLLAPSED_KEY, next ? '1' : '0');
    } catch {
      // Storage can be blocked; the preference is then per page view only.
    }
  };

  return (
    <div className="flex min-h-screen" data-testid="app-shell">
      <aside
        data-testid="app-shell-sidebar"
        data-collapsed={collapsed}
        className={`hidden shrink-0 border-r border-border p-3 md:block ${collapsed ? 'w-14' : 'w-56'}`}
      >
        <NavList roles={roles} collapsed={collapsed} />
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-2 border-b border-border px-4 py-2">
          <Sheet open={drawerOpen} onOpenChange={setDrawerOpen}>
            <SheetTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="md:hidden"
                aria-label="Open navigation"
              >
                <Menu aria-hidden="true" className="size-4" />
              </Button>
            </SheetTrigger>
            <SheetContent side="left">
              <SheetTitle>Navigation</SheetTitle>
              <SheetDescription className="sr-only">Console sections</SheetDescription>
              <div
                onClick={(event) => {
                  if (event.target instanceof Element && event.target.closest('a') !== null) {
                    setDrawerOpen(false);
                  }
                }}
              >
                <NavList roles={roles} />
              </div>
            </SheetContent>
          </Sheet>
          <Button
            variant="ghost"
            size="icon"
            className="hidden md:inline-flex"
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            aria-expanded={!collapsed}
            onClick={toggleCollapsed}
          >
            {collapsed ? (
              <PanelLeftOpen aria-hidden="true" className="size-4" />
            ) : (
              <PanelLeftClose aria-hidden="true" className="size-4" />
            )}
          </Button>
          <span className="font-semibold">Blackwing</span>
          <div className="ml-4 min-w-0 flex-1">
            <Breadcrumbs />
          </div>
          <ModeToggle />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                aria-label="User menu"
                data-testid="app-shell-user"
              >
                <Avatar className="size-7">
                  <AvatarFallback>{label.slice(0, 1).toUpperCase()}</AvatarFallback>
                </Avatar>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>
                <div className="max-w-60 truncate">{label}</div>
                {roles.length > 0 && (
                  <div className="max-w-60 truncate text-xs font-normal text-muted-foreground">
                    {roles.join(', ')}
                  </div>
                )}
              </DropdownMenuLabel>
            </DropdownMenuContent>
          </DropdownMenu>
        </header>
        <main id="main-content" tabIndex={-1} className="flex-1 p-6">
          {children}
        </main>
      </div>
    </div>
  );
}
