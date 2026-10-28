import { createTransport } from 'nodemailer';

/**
 * E-mail delivery for NOTIFY (CONTEXT_PACK §3.1): callers hand an {@link EmailSender} a rendered message
 * and never speak SMTP themselves. Templates are plain functions of typed data, so a caller cannot send
 * a template with a missing or misspelt field.
 */

/** A rendered message. `to` is a single address: the sender never fans out. */
export interface EmailMessage {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}

/** Delivers one message. Rejects when the relay did not accept it; never retries by itself. */
export interface EmailSender {
  send(message: EmailMessage): Promise<void>;
}

/** Ids of the templates {@link renderEmail} knows. */
export type EmailTemplateId = 'signup_verify';

/** Data each template takes. */
export interface EmailTemplateData {
  readonly signup_verify: {
    /** The single-use link; it is the credential, so it appears only in the body. */
    readonly verifyUrl: string;
    readonly orgName: string;
    readonly expiresInHours: number;
  };
}

const HTML_ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** Escapes text for an HTML body or a double-quoted attribute. */
function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] ?? char);
}

type Rendered = Pick<EmailMessage, 'subject' | 'text' | 'html'>;

const TEMPLATES: { readonly [K in EmailTemplateId]: (data: EmailTemplateData[K]) => Rendered } = {
  signup_verify: ({ verifyUrl, orgName, expiresInHours }) => {
    const hours = `${String(expiresInHours)} hour${expiresInHours === 1 ? '' : 's'}`;
    return {
      subject: 'Verify your email to create your Blackwing organisation',
      text: [
        `Confirm your email address to create the organisation "${orgName}" on Blackwing.`,
        '',
        verifyUrl,
        '',
        `The link works once and expires in ${hours}. If you did not ask for this, ignore this email: nothing is created until the link is opened.`,
      ].join('\n'),
      html: [
        `<p>Confirm your email address to create the organisation <strong>${escapeHtml(orgName)}</strong> on Blackwing.</p>`,
        `<p><a href="${escapeHtml(verifyUrl)}">Verify my email</a></p>`,
        `<p>The link works once and expires in ${hours}. If you did not ask for this, ignore this email: nothing is created until the link is opened.</p>`,
      ].join('\n'),
    };
  },
};

/** Renders template `id` for `to`. */
export function renderEmail<Id extends EmailTemplateId>(
  id: Id,
  to: string,
  data: EmailTemplateData[Id],
): EmailMessage {
  return { to, ...TEMPLATES[id](data) };
}

/** Connection to the SMTP relay (Mailpit in dev, the platform relay elsewhere). */
export interface SmtpConfig {
  readonly host: string;
  readonly port: number;
  /** Envelope and header sender, e.g. `Blackwing <no-reply@blackwing.example>`. */
  readonly from: string;
  /** Implicit TLS (port 465). Otherwise the connection upgrades with STARTTLS when the relay offers it. */
  readonly secure?: boolean;
  readonly auth?: { readonly user: string; readonly pass: string };
}

/** An {@link EmailSender} over SMTP. Timeouts are bounded so a hung relay fails the call instead of hanging it. */
export function createSmtpEmailSender(config: SmtpConfig): EmailSender {
  const transport = createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure ?? false,
    ...(config.auth === undefined ? {} : { auth: config.auth }),
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
  return {
    async send(message) {
      await transport.sendMail({ from: config.from, ...message });
    },
  };
}
