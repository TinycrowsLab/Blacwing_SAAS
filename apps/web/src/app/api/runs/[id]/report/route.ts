// The run report as a download (HTML, Markdown, JSON or SARIF). The API supplies the released findings as JSON (and the
// SARIF file); the console words the HTML and Markdown itself (results/report-file.ts), so the file says what the
// page says: released issues only, most severe first, plain words, and no agent summary of issues left out.
import { z } from 'zod';

import {
  ordered,
  renderHtml,
  renderJson,
  renderMarkdown,
  REPORT_FORMATS,
  reportFilename,
  reportSourceSchema,
} from '../../../../../components/console/results/report-file';
import { ApiError, callApi } from '../../../../../lib/api';
import { getViewer } from '../../../../../lib/auth';

export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HTTP_UNAUTHORIZED = 401;
const HTTP_BAD_REQUEST = 400;
const HTTP_NOT_FOUND = 404;
const HTTP_SERVER_ERROR = 500;

const renderedSchema = z.object({ contentType: z.string().min(1), filename: z.string(), body: z.string() });
const TYPES = {
  html: 'text/html; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  json: 'application/json',
  sarif: 'application/sarif+json',
} as const;

export async function GET(
  request: Request,
  { params }: { readonly params: Promise<{ readonly id: string }> },
): Promise<Response> {
  const session = await getViewer();
  if (session === null) return new Response('Sign in first.', { status: HTTP_UNAUTHORIZED });
  const { id } = await params;
  if (!UUID.test(id)) return new Response('That audit does not exist.', { status: HTTP_NOT_FOUND });
  const asked = (new URL(request.url).searchParams.get('format') ?? 'html').trim().toLowerCase();
  const format = REPORT_FORMATS.find((f) => f === asked);
  if (format === undefined)
    return new Response('Choose a format: html, md, json or sarif.', { status: HTTP_BAD_REQUEST });
  const path = (f: string): string => `/runs/${encodeURIComponent(id)}/report?format=${f}`;
  try {
    const [json, sarif] = await Promise.all([
      callApi(session, path('json')).then((r) => renderedSchema.parse(r)),
      format === 'sarif' ? callApi(session, path('sarif')).then((r) => renderedSchema.parse(r)) : Promise.resolve(null),
    ]);
    const raw = z.record(z.string(), z.unknown()).parse(JSON.parse(json.body));
    const source = reportSourceSchema.parse(raw);
    const findings = ordered(source);
    const body =
      format === 'html'
        ? renderHtml(source, findings, new Date().toISOString())
        : format === 'md'
          ? renderMarkdown(source, findings)
          : format === 'json'
            ? renderJson(raw, findings)
            : (sarif?.body ?? '');
    return new Response(body, {
      headers: {
        'content-type': TYPES[format],
        // reportFilename yields only [a-z0-9.-], so a quote or newline can never break the header.
        'content-disposition': `attachment; filename="${reportFilename(source, format)}"`,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      },
    });
  } catch (error) {
    if (error instanceof ApiError) return new Response(error.message, { status: error.status });
    return new Response('The report could not be rendered.', { status: HTTP_SERVER_ERROR });
  }
}
