/** Workspace package name of this package. */
export const name = '@blackwing/ui';

/** Package version; kept in sync with package.json. */
export const version = '0.0.0';

export { cn } from './lib/cn';
export { tailwindPreset } from './tailwind-preset';

export { Avatar, AvatarFallback, AvatarImage } from './components/avatar';
export { Badge, badgeVariants, type BadgeProps } from './components/badge';
export {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from './components/breadcrumb';
export { Button, buttonVariants, type ButtonProps } from './components/button';
export {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from './components/card';
export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
} from './components/dialog';
export {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './components/dropdown-menu';
export { FormField, type FormFieldProps } from './components/form-field';
export {
  FirstRunChecklist,
  type FirstRunChecklistProps,
  type FirstRunStep,
} from './components/help/first-run-checklist';
export { HelpPopover, type HelpPopoverProps } from './components/help/help-popover';
export {
  HELP_TOPIC_IDS,
  HELP_TOPICS,
  isHelpTopicId,
  type HelpTopic,
  type HelpTopicId,
} from './components/help/help-topics';
export { resolveDocsLink, type DocsLinkInput } from './components/help/resolve-docs-link';
export { Input, type InputProps } from './components/input';
export { Label } from './components/label';
export {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from './components/select';
export { Separator } from './components/separator';
export {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
  type SheetContentProps,
} from './components/sheet';
export { Skeleton } from './components/skeleton';
export {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from './components/table';
export { Tabs, TabsContent, TabsList, TabsTrigger } from './components/tabs';
export {
  Toast,
  ToastAction,
  ToastClose,
  ToastDescription,
  ToastProvider,
  ToastTitle,
  ToastViewport,
  toastVariants,
} from './components/toast';
export { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './components/tooltip';
export {
  MAX_DETAIL_CHARS,
  classifyApiError,
  errorCopy,
  safeCode,
  safeTraceId,
  sanitizeDetail,
  type ApiErrorKind,
  type ApiErrorLike,
} from './components/states/api-error';
export { EmptyState, type EmptyStateProps } from './components/states/empty-state';
export { ErrorState, retryDelayMs, type ErrorStateProps } from './components/states/error-state';
export {
  LoadingState,
  type LoadingStateProps,
  type LoadingVariant,
} from './components/states/loading-state';
export { NotFound, type NotFoundProps } from './components/states/not-found';
export {
  PermissionDenied,
  type PermissionDeniedProps,
} from './components/states/permission-denied';
export { QueryState, type QueryStateProps } from './components/states/query-state';
