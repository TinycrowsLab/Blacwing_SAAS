// Declarative console navigation (CONSOLE-004, #264). Feature epics add items here without touching
// <AppShell>. Gating is cosmetic: the server re-checks every request (CONTEXT_PACK §8.6, §8.7), and a
// direct visit to a hidden route still gets the permission-denied state.

import {
  Activity,
  FileSearch,
  Gauge,
  LayoutDashboard,
  type LucideIcon,
  ScrollText,
  Settings,
  ShieldCheck,
  Target,
  Users,
} from 'lucide-react';

import { hasPermission } from '@blackwing/domain';

import type { MessageKey } from './i18n';
import type { Permission } from '@blackwing/contracts';

const NAV_SECTIONS = ['Runs', 'Assets', 'Findings', 'Dashboards', 'Admin'] as const;
export type NavSection = (typeof NAV_SECTIONS)[number];

/** Catalogue key of each section heading (apps/web/src/messages/en.json). */
export const NAV_SECTION_LABEL_KEYS: Readonly<Record<NavSection, MessageKey>> = {
  Runs: 'nav.section.runs',
  Assets: 'nav.section.assets',
  Findings: 'nav.section.findings',
  Dashboards: 'nav.section.dashboards',
  Admin: 'nav.section.admin',
};

export interface NavItem {
  readonly key: string;
  /** Catalogue key of the visible label; render it with `t()`. */
  readonly labelKey: MessageKey;
  readonly href: string;
  readonly icon: LucideIcon;
  /** Omit for items every signed-in user may see. */
  readonly requiredPermission?: Permission;
  readonly section: NavSection;
}

export const NAV_ITEMS: readonly NavItem[] = [
  {
    key: 'runs',
    labelKey: 'nav.item.runs',
    href: '/runs',
    icon: Activity,
    requiredPermission: 'run:read',
    section: 'Runs',
  },
  {
    key: 'assets',
    labelKey: 'nav.item.assets',
    href: '/assets',
    icon: Target,
    requiredPermission: 'asset:read',
    section: 'Assets',
  },
  {
    key: 'authorisations',
    labelKey: 'nav.item.authorisations',
    href: '/authorisations',
    icon: ShieldCheck,
    requiredPermission: 'sa:read',
    section: 'Assets',
  },
  {
    key: 'findings',
    labelKey: 'nav.item.findings',
    href: '/findings',
    icon: FileSearch,
    requiredPermission: 'finding:read',
    section: 'Findings',
  },
  {
    key: 'overview',
    labelKey: 'nav.item.overview',
    href: '/',
    icon: LayoutDashboard,
    section: 'Dashboards',
  },
  {
    key: 'coverage',
    labelKey: 'nav.item.coverage',
    href: '/coverage',
    icon: Gauge,
    requiredPermission: 'coverage:read',
    section: 'Dashboards',
  },
  {
    key: 'members',
    labelKey: 'nav.item.members',
    href: '/admin/members',
    icon: Users,
    requiredPermission: 'member:read',
    section: 'Admin',
  },
  {
    key: 'settings',
    labelKey: 'nav.item.settings',
    href: '/admin/settings',
    icon: Settings,
    requiredPermission: 'settings:read',
    section: 'Admin',
  },
  {
    key: 'audit',
    labelKey: 'nav.item.audit',
    href: '/admin/audit',
    icon: ScrollText,
    requiredPermission: 'audit:read',
    section: 'Admin',
  },
];

/** Items `roles` may see, grouped by section in catalogue order; empty sections are dropped. Unknown or empty roles keep only ungated items. */
export function visibleNav(
  roles: readonly string[],
  items: readonly NavItem[] = NAV_ITEMS,
): readonly { readonly section: NavSection; readonly items: readonly NavItem[] }[] {
  return NAV_SECTIONS.map((section) => ({
    section,
    items: items.filter(
      (item) =>
        item.section === section &&
        (item.requiredPermission === undefined || hasPermission(roles, item.requiredPermission)),
    ),
  })).filter((group) => group.items.length > 0);
}

/** True when `pathname` is the item's route or nested under it ("/" matches only itself). */
export function isActive(pathname: string, href: string): boolean {
  return href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(`${href}/`);
}
