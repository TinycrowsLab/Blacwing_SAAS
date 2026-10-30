/** Workspace package name of this package. */
export const name = '@blackwing/notify';

/** Package version; kept in sync with package.json. */
export const version = '0.0.0';

export {
  type ChannelRegistry,
  createChannelRegistry,
  type NotificationChannel,
  type NotificationSendResult,
  type RenderedMessage,
  validateWithKindSchema,
} from './channel.js';
export {
  createSmtpEmailSender,
  type EmailMessage,
  type EmailSender,
  type EmailTemplateData,
  type EmailTemplateId,
  renderEmail,
  type SmtpConfig,
} from './email.js';
export {
  createNotifier,
  type DryRunDelivery,
  type Notifier,
  type NotifyOptions,
  type NotifyOutcome,
  type NotifierDeps,
} from './notifier.js';
export { createNotifyMetrics, NOOP_NOTIFY_METRICS, type NotifyMetrics } from './metrics.js';
export {
  deliveryDedupeKey,
  type DeliveryPlan,
  type PlannedDelivery,
  planDeliveries,
  type PlanInput,
  type RoutableChannel,
  type SkipReason,
  type SkippedChannel,
} from './plan.js';
export {
  consoleLinkFor,
  renderNotification,
  RENDER_TEXT_MAX,
  type RenderOptions,
} from './render.js';
