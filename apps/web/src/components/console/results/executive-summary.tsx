// The AI-written executive summary at the top of the results page. It is prose by Blackwing AI, not verified.
import { Markdown } from '../markdown';
import { SUMMARY_TAG } from './report-file';

export function ExecutiveSummary({ markdown }: { readonly markdown: string | null }) {
  const body = (markdown ?? '').replace(/^#{1,2}\s*Executive summary\s*\n/i, '').trim();
  if (body === '') return null;
  return (
    <section aria-labelledby="exec-summary-h" className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h2 id="exec-summary-h" className="m-0 text-[17px] font-semibold text-foreground">
          Executive summary
        </h2>
        <span className="rounded-full border border-border px-2 py-0.5 text-[11.5px] text-muted-foreground">
          {SUMMARY_TAG}
        </span>
      </div>
      <div className="text-[14px] leading-[22px] text-foreground">
        <Markdown text={body} />
      </div>
    </section>
  );
}
