import { notFound, redirect } from 'next/navigation';

import { assessmentRequestPublicIdSchema } from '@blackwing/contracts';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@blackwing/ui';

import { AssessmentWizard } from './_components/wizard';
import { canCreateAssessment, isWizardStep, readWizardState } from './wizard-model';
import { getSession } from '../../../../../lib/session';

export const dynamic = 'force-dynamic';

type SearchParams = Readonly<Record<string, string | string[] | undefined>>;

/** The first query value of a parameter, or undefined. Repeated parameters take the first one. */
function firstValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * `/assessments/new/[step]`: the scoping wizard (SCOPE-005 console form). The session is checked on the server, and a
 * caller without `assessment:create` sees the permission-denied state (the API refuses the same calls, §8.11).
 * A malformed step or draft id is a 404 before anything loads. The search string is kept on the redirect from
 * `/assessments/new` so the answers in the URL survive it.
 */
export default async function NewAssessmentPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly step?: string[] }>;
  readonly searchParams: Promise<SearchParams>;
}) {
  const { step } = await params;
  const query = await searchParams;
  const session = await getSession();
  if (session === null) redirect('/login');
  if (!canCreateAssessment(session.roles)) {
    return (
      <Card className="mx-auto max-w-xl">
        <CardHeader>
          <CardTitle>You cannot create assessment requests</CardTitle>
          <CardDescription>
            Your role does not include assessment:create in this tenant. Ask an administrator for
            access.
          </CardDescription>
        </CardHeader>
        <CardContent />
      </Card>
    );
  }

  if (step === undefined || step.length === 0) {
    const carried = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      const single = firstValue(value);
      if (single !== undefined) carried.set(key, single);
    }
    const suffix = carried.toString();
    redirect(`/assessments/new/mode${suffix === '' ? '' : `?${suffix}`}`);
  }
  const [stepName, ...rest] = step;
  if (rest.length > 0 || !isWizardStep(stepName)) notFound();

  const requestParam = firstValue(query.request);
  let requestId: string | null = null;
  if (requestParam !== undefined) {
    const parsed = assessmentRequestPublicIdSchema.safeParse(requestParam);
    if (!parsed.success) notFound();
    requestId = parsed.data;
  }

  return (
    <AssessmentWizard step={stepName} requestId={requestId} urlAnswers={readWizardState(query)} />
  );
}
