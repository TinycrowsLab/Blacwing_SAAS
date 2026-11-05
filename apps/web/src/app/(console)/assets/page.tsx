// Assets: register a target (origins and excluded paths define the scope) and prove ownership before any test.
import { z } from 'zod';

import {
  Card,
  CardHeader,
  Chip,
  DataTable,
  ErrorBanner,
  INPUT_CLASS,
  Icon,
  IdChip,
  LinkButton,
  PageHeader,
  StatusChip,
  buttonClass,
  queryText,
} from '../../../components/console/design';
import { ContextPanel } from '../../../components/console/shell';
import { callApi } from '../../../lib/api';
import { getViewer } from '../../../lib/auth';
import { type Asset, assetSchema } from '../../../lib/schemas';
import { createAssetAction, verifyAssetAction } from '../audits/actions';

import type { ReactNode } from 'react';

export const dynamic = 'force-dynamic';

const listSchema = z.object({ items: z.array(assetSchema) });
const LABEL = 'flex flex-col gap-1.5 text-[12.5px] font-medium text-foreground';
const HINT = 'text-xs font-normal text-muted-foreground';

function VerifyPanel({ asset, isOwner }: { readonly asset: Asset; readonly isOwner: boolean }) {
  return (
    <Card aria-label={`Verify ${asset.name}`}>
      <CardHeader title={`Verify ownership of ${asset.name}`} meta="Asset owner only" />
      <div className="flex flex-col gap-4 p-4 text-[13px]">
        {asset.verification === null ? null : (
          <div className="flex flex-col gap-2">
            <p className="m-0 text-muted-foreground">
              Serve this token at the well-known URL, then verify. The API fetches it without
              following redirects.
            </p>
            <code className="break-all rounded-lg border border-border bg-code p-2.5 font-mono text-[12px]">
              {asset.verification.wellKnownUrl}
            </code>
            <code className="break-all rounded-lg border border-border bg-code p-2.5 font-mono text-[12px]">
              {asset.verification.token}
            </code>
          </div>
        )}
        {isOwner ? (
          <div className="flex flex-col gap-4 md:flex-row md:items-end">
            <form action={verifyAssetAction}>
              <input type="hidden" name="assetId" value={asset.id} />
              <button type="submit" className={buttonClass('primary')}>
                Verify via HTTP token
              </button>
            </form>
            <form
              action={verifyAssetAction}
              className="flex flex-1 flex-col gap-2 md:flex-row md:items-end"
            >
              <input type="hidden" name="assetId" value={asset.id} />
              <label className={`${LABEL} flex-1`}>
                Attest ownership
                <input
                  name="statement"
                  minLength={10}
                  required
                  placeholder="I am authorised to test this system (lab or owned)"
                  className={INPUT_CLASS}
                />
              </label>
              <button type="submit" className={buttonClass('secondary')}>
                Attest ownership
              </button>
            </form>
          </div>
        ) : (
          <p className="m-0 flex items-center gap-2 text-muted-foreground">
            <Icon name="lock" size={14} /> Only an asset owner can verify. Sign in as one.
          </p>
        )}
      </div>
    </Card>
  );
}

export default async function AssetsPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<ReactNode> {
  const session = await getViewer();
  if (session === null) return null;
  const query = await searchParams;
  const { items } = listSchema.parse(await callApi(session, '/assets'));
  const canRegister = session.roles.includes('appsec-engineer');
  const isOwner = session.roles.includes('asset-owner');
  return (
    <div className="flex flex-col gap-3">
      <PageHeader
        crumbs={[{ label: 'Assets' }]}
        title="Assets"
        chips={
          <span className="text-[13px] text-muted-foreground">{items.length} in this tenant</span>
        }
      />
      <ErrorBanner error={queryText(query.error)} message={queryText(query.message)} />
      <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="flex min-w-0 flex-col gap-3">
          <Card>
            <DataTable label="Assets" head={['Asset', 'Allowed origins', 'Ownership', '']}>
              {items.map((asset) => (
                <tr key={asset.id} className="hover:bg-primary-soft/40">
                  <td className="px-4 py-3 font-medium">
                    <span className="flex items-center gap-2">
                      <Icon name="host" size={16} className="text-muted-foreground" />
                      {asset.name}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <span className="flex flex-wrap gap-1.5">
                      {(asset.allowedOrigins.length > 0
                        ? asset.allowedOrigins
                        : [asset.baseUrl]
                      ).map((o) => (
                        <IdChip key={o}>{o}</IdChip>
                      ))}
                    </span>
                    {asset.excludedPaths.length > 0 ? (
                      <span className="mt-1 block text-[11.5px] text-muted-foreground">
                        Excluded: {asset.excludedPaths.join(', ')}
                      </span>
                    ) : null}
                  </td>
                  <td className="px-4 py-3">
                    <span className="flex flex-col gap-1">
                      {asset.ownership.status === 'verified' ? (
                        <Chip tone="ok" icon="check" pill>
                          Verified
                        </Chip>
                      ) : (
                        <StatusChip value={asset.ownership.status} />
                      )}
                      {asset.ownership.method === null ? null : (
                        <span className="text-[11.5px] text-muted-foreground">
                          {asset.ownership.method.replace(/_/g, ' ')}
                        </span>
                      )}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right">
                    {asset.ownership.status !== 'verified' ? null : canRegister ? (
                      <LinkButton
                        href={`/requests/new?assetId=${encodeURIComponent(asset.id)}`}
                        variant="secondary"
                        icon="assessments"
                        className="!h-9"
                      >
                        Request assessment
                      </LinkButton>
                    ) : (
                      <span className="text-xs text-muted-foreground">
                        Only an AppSec engineer can request an assessment.
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </DataTable>
            {items.length === 0 ? (
              <p className="p-4 text-[13px] text-muted-foreground">
                No assets yet. Register a target.
              </p>
            ) : null}
          </Card>
          {items
            .filter((a) => a.ownership.status !== 'verified')
            .map((a) => (
              <VerifyPanel key={a.id} asset={a} isOwner={isOwner} />
            ))}
        </div>
        <div className="flex flex-col gap-3">
          <Card aria-labelledby="register-h">
            <CardHeader id="register-h" title="Register target" meta="AppSec engineer" />
            <form action={createAssetAction} className="flex flex-col gap-4 p-4">
              <label className={LABEL}>
                Name
                <input
                  name="name"
                  required
                  maxLength={120}
                  disabled={!canRegister}
                  className={INPUT_CLASS}
                />
              </label>
              <label className={LABEL}>
                Base URL
                <input
                  name="baseUrl"
                  type="url"
                  required
                  placeholder="https://app.example.com"
                  disabled={!canRegister}
                  className={`${INPUT_CLASS} font-mono`}
                />
                <span className={HINT}>
                  Its origin is in scope. Nothing else is, unless listed below.
                </span>
              </label>
              <label className={LABEL}>
                Extra origins
                <textarea
                  name="extraOrigins"
                  rows={2}
                  disabled={!canRegister}
                  placeholder="https://api.example.com:8443"
                  className={`${INPUT_CLASS} h-auto py-2 font-mono`}
                />
                <span className={HINT}>Scheme, host and port. One per line.</span>
              </label>
              <label className={LABEL}>
                Excluded paths
                <textarea
                  name="excludedPaths"
                  rows={2}
                  disabled={!canRegister}
                  placeholder="/admin"
                  className={`${INPUT_CLASS} h-auto py-2 font-mono`}
                />
                <span className={HINT}>Never requested, even inside an allowed origin.</span>
              </label>
              <button type="submit" disabled={!canRegister} className={buttonClass('primary')}>
                Register target
              </button>
              {canRegister ? null : (
                <span className={HINT}>Only an AppSec engineer can register a target.</span>
              )}
            </form>
          </Card>
          <ContextPanel
            sections={[
              {
                title: 'Ownership',
                body: 'An asset must be verified before any request. Serve the token over HTTP, or an asset owner attests authority for a lab or owned system.',
              },
              {
                title: 'Scope',
                body: 'Every request the agents make is checked against the allowed origins and excluded paths before it is sent.',
              },
            ]}
          />
        </div>
      </div>
    </div>
  );
}
