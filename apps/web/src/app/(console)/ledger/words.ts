// The ledger's words for the entries that carry their own detail (ownership, plan edits, run starts and pauses, a
// request nobody answered, a retest). Everything else keeps the shared label (results/model.ts actionLabel).
import { shortId } from '../../../components/console/run-model';

type Payload = Readonly<Record<string, unknown>>;

const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);

function pathOf(url: string): string {
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}`;
  } catch {
    return url;
  }
}

/** The plan's fields as the plan read-back names them; an unknown field shows as itself. */
const FIELDS: Readonly<Record<string, string>> = {
  objective: 'what to look for',
  excludedPaths: 'paths to avoid',
  intrusiveness: 'how careful',
  budget: 'limits',
  budgetRequests: 'limits',
  budgetSeconds: 'limits',
  costCapUsd: 'limits',
  testAccounts: 'test accounts',
  accounts: 'test accounts',
  releaseProven: 'release of proven issues',
};

/**
 * Words for `action`, or null when the shared label applies. Each already holds the entry's detail, so the row shows
 * nothing more from the payload.
 */
export function ledgerWords(action: string, payload: Payload, targetId: string): string | null {
  const origin = text(payload.origin) ?? 'the site';
  switch (action) {
    case 'asset.verified':
      return `Proved ownership of ${origin} by ${payload.method === 'owner_attestation' ? 'attestation' : 'file'}`;
    case 'asset.unverified': {
      const reason = text(payload.reason);
      return `Ownership of ${origin} lapsed${reason === null ? '' : `: ${reason}`}`;
    }
    case 'gate1.amend': {
      const version = typeof payload.version === 'number' ? ` (version ${payload.version})` : '';
      const fields = (text(payload.changed) ?? '').split(',').map((c) => c.trim()).filter(Boolean);
      const changed = fields.length === 0 ? null : [...new Set(fields.map((f) => FIELDS[f] ?? f))].join(', ');
      return `Edited the plan${version}${changed === null ? '' : `: ${changed}`}`;
    }
    case 'run.started':
      return `Started audit ${shortId(targetId)}`;
    case 'run.pause':
      return 'Paused the audit';
    case 'run.resume':
      return 'Resumed the audit';
    case 'gate2.expired': {
      const method = text(payload.method);
      const url = text(payload.url);
      return method === null || url === null
        ? 'No answer in time: the request was not sent'
        : `No answer in time: ${method.toUpperCase()} ${pathOf(url)} was not sent`;
    }
    case 'finding.retest':
      return 'Asked Blackwing to retest a finding';
    default:
      return null;
  }
}
