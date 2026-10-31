// `plan_templates_total{class}`: templates per selectable class in the loaded library version (PLANNER-002, #428).
// The library is immutable per version, so the gauge reads the counts computed from the validated templates.

import { templateCountsByClass, type Template, TEMPLATE_CLASSES } from './template.js';

import type { Meter } from '@opentelemetry/api';

export const PLAN_TEMPLATES_TOTAL_METRIC = 'plan_templates_total';

/** Creates the observable gauge on `meter`, one observation per selectable class (zero included). */
export function createPlanTemplatesTotalMetric(meter: Meter, templates: readonly Template[]): void {
  const counts = templateCountsByClass(templates);
  meter
    .createObservableGauge(PLAN_TEMPLATES_TOTAL_METRIC, {
      description: 'Test-case templates per class in the pinned library version',
    })
    .addCallback((result) => {
      for (const templateClass of TEMPLATE_CLASSES) {
        result.observe(counts[templateClass], { class: templateClass });
      }
    });
}
