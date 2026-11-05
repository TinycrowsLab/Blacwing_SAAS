// The run report as a download (HTML, Markdown, JSON or SARIF), rendered by the API.
import { ApiError, callApi } from '../../../../../lib/api';
import { getViewer } from '../../../../../lib/auth';

export const dynamic = 'force-dynamic';

const FORMATS = ['html', 'md', 'json', 'sarif'] as const;

interface RenderedReport {
  readonly contentType: string;
  readonly filename: string;
  readonly body: string;
}

export async function GET(
  request: Request,
  { params }: { readonly params: Promise<{ readonly id: string }> },
): Promise<Response> {
  const session = await getViewer();
  if (session === null) return new Response('Sign in first.', { status: 401 });
  const { id } = await params;
  const asked = new URL(request.url).searchParams.get('format');
  const format = FORMATS.find((f) => f === asked) ?? 'html';
  try {
    const report = await callApi<RenderedReport>(
      session,
      `/runs/${encodeURIComponent(id)}/report?format=${format}`,
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
