// The finding report as a download (HTML or Markdown), rendered by the API.
import { z } from 'zod';

import { ApiError, callApi } from '../../../../../lib/api';
import { getViewer } from '../../../../../lib/auth';

export const dynamic = 'force-dynamic';

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
  const format = new URL(request.url).searchParams.get('format') === 'md' ? 'md' : 'html';
  try {
    const report = renderedSchema.parse(
      await callApi(session, `/findings/${encodeURIComponent(id)}/report?format=${format}`),
    );
    return new Response(report.body, {
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
