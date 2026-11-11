// "External exposure" on the results page: what the public web shows about the organisation (the threat-intel phase,
// run before any testing). Organisation level only. Items that no validator replayed are labelled "intel, not verified".
import type { Intel } from '../../../lib/schemas';

const BASIS_LABEL: Readonly<Record<Intel['items'][number]['basis'], string>> = {
  finding: 'Confirmed finding',
  observed: 'Observed',
  unverified: 'Intel, not verified',
};

export function ExternalExposure({ intel }: { readonly intel: Intel | null }) {
  if (intel === null) return null;
  const skipped = intel.skipped;
  return (
    <section aria-labelledby="exposure-h" className="flex flex-col gap-1">
      <h2 id="exposure-h" className="m-0 mb-1 text-[17px] font-semibold text-foreground">
        External exposure
      </h2>
      <p className="m-0 text-[13.5px] leading-[21px] text-muted-foreground">
        {skipped === null
          ? `What the public web shows about ${intel.domains.length === 0 ? 'your organisation' : intel.domains.join(', ')}, gathered passively before testing. Secrets are redacted and nothing about individuals is collected.`
          : `${skipped}.`}
      </p>
      {intel.items.length === 0 ? (
        <p className="m-0 mt-1 text-[13.5px] text-muted-foreground">No exposure items were found.</p>
      ) : (
        <ul className="m-0 list-none p-0">
          {intel.items.map((item) => (
            <li
              key={`${item.source}-${item.title}-${item.detail}`}
              className="grid gap-x-4 gap-y-0.5 border-b border-border py-2.5 text-[13.5px] leading-[21px] sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]"
            >
              <span className="min-w-0 break-words font-medium text-foreground">
                {item.title}
                <span className="ml-2 text-[11.5px] font-normal text-muted-foreground">
                  {item.severity} · {BASIS_LABEL[item.basis]}
                </span>
              </span>
              <span className="min-w-0 break-words text-muted-foreground">{item.detail}</span>
            </li>
          ))}
        </ul>
      )}
      {intel.discoveredHosts.length === 0 ? null : (
        <p className="m-0 mt-2 break-words text-[13px] leading-5 text-muted-foreground">
          <b className="font-semibold text-foreground">{intel.discoveredHosts.length} more hosts of the organisation</b> appear in public
          sources outside the approved scope. They were reported and not tested: {intel.discoveredHosts.join(', ')}.
        </p>
      )}
      {intel.sources.length === 0 ? null : (
        <ul className="m-0 mt-2 list-none p-0 text-[12.5px] leading-5 text-muted-foreground">
          {intel.sources.map((s) => (
            <li key={s.name}>
              {s.name}: {s.note}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
