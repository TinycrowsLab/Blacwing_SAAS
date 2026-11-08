// The finding report as a download (HTML or Markdown), rendered by the API and scrubbed of secrets once more here. Any
// other format is a 400, never a guess.
import { z } from 'zod';

import { scrub } from '@blackwing/errors/scrub';

import { ApiError, callApi } from '../../../../../lib/api';
import { getViewer } from '../../../../../lib/auth';

export const dynamic = 'force-dynamic';

const FORMATS = ['html', 'md'] as const;

// The filename goes into a header: only safe characters, so a quote or newline can never break it.
const renderedSchema = z.object({
  contentType: z.string().min(1),
  filename: z.string().regex(/^[\w.-]{1,120}$/),
  body: z.string(),
});

export async function GET(
  request: Request,
  { params }: { readonly params: Promise<{ readonly id: string }> },
): Promise<Response> {
  const session = await getViewer();
  if (session === null) return new Response('Sign in first.', { status: 401 });
  const { id } = await params;
  const asked = (new URL(request.url).searchParams.get('format') ?? 'html').trim().toLowerCase();
  const format = FORMATS.find((f) => f === asked);
  if (format === undefined) return new Response('Choose a format: html or md.', { status: 400 });
  try {
    const report = renderedSchema.parse(
      await callApi(session, `/findings/${encodeURIComponent(id)}/report?format=${format}`),
    );
    // The API scrubs the evidence it renders; scrubbing the file again here means no token or password can slip out.
    return new Response(scrub(report.body), {
      headers: {
        'content-type': report.contentType,
        'content-disposition': `attachment; filename="${report.filename}"`,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      },
    });
  } catch (error) {
    if (error instanceof ApiError) return new Response(error.message, { status: error.status });
    return new Response('The report could not be rendered.', { status: 500 });
  }
}
