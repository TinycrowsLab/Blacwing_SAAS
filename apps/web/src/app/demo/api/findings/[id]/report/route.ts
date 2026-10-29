// DEMO-STORY: the finding report as a download (HTML or Markdown), rendered by the demo API.
import { getSession } from '../../../../../../lib/session';
import { DemoApiError, demoApi } from '../../../../_lib/demo-api';

export const dynamic = 'force-dynamic';

interface RenderedReport {
  readonly contentType: string;
  readonly filename: string;
  readonly body: string;
}

export async function GET(
  request: Request,
  { params }: { readonly params: Promise<{ readonly id: string }> },
): Promise<Response> {
  const session = await getSession();
  if (session === null) return new Response('Sign in first.', { status: 401 });
  const { id } = await params;
  const format = new URL(request.url).searchParams.get('format') === 'md' ? 'md' : 'html';
  try {
    const report = await demoApi<RenderedReport>(session, `/findings/${encodeURIComponent(id)}/report?format=${format}`);
    return new Response(report.body, {
      headers: {
        'content-type': report.contentType,
        'content-disposition': `attachment; filename="${report.filename}"`,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      },
    });
  } catch (error) {
    if (error instanceof DemoApiError) return new Response(error.message, { status: error.status });
    return new Response('The report could not be rendered.', { status: 500 });
  }
}
