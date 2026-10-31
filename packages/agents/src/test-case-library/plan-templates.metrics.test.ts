import { describe, expect, it } from 'vitest';

import { loadTestCaseLibrary } from './library.js';
import {
  createPlanTemplatesTotalMetric,
  PLAN_TEMPLATES_TOTAL_METRIC,
} from './plan-templates.metrics.js';
import { templateCountsByClass } from './template.js';

import type { Meter } from '@opentelemetry/api';

interface Observation {
  readonly value: number;
  readonly attributes: Readonly<Record<string, string>>;
}

/** A meter that keeps the gauge callback so the test can run one observation pass. */
function fakeMeter() {
  let callback:
    | ((result: { observe(value: number, attributes: Record<string, string>): void }) => void)
    | undefined;
  const names: string[] = [];
  const meter = {
    createObservableGauge(name: string) {
      names.push(name);
      return {
        addCallback(cb: typeof callback) {
          callback = cb;
        },
      };
    },
  } as unknown as Meter;
  const collect = (): Observation[] => {
    const seen: Observation[] = [];
    callback?.({ observe: (value, attributes) => seen.push({ value, attributes }) });
    return seen;
  };
  return { meter, names, collect };
}

describe('plan_templates_total{class}', () => {
  const library = loadTestCaseLibrary();

  it('registers one observable gauge under the metric name', () => {
    const { meter, names } = fakeMeter();
    createPlanTemplatesTotalMetric(meter, library.templates);
    expect(names).toEqual([PLAN_TEMPLATES_TOTAL_METRIC]);
    expect(PLAN_TEMPLATES_TOTAL_METRIC).toBe('plan_templates_total');
  });

  it('observes one value per selectable class, matching the library counts, zero included', () => {
    const { meter, collect } = fakeMeter();
    createPlanTemplatesTotalMetric(meter, library.templates);
    const counts = templateCountsByClass(library.templates);
    expect(collect()).toEqual([
      { value: counts.passive, attributes: { class: 'passive' } },
      { value: counts.active_safe, attributes: { class: 'active_safe' } },
      { value: counts.state_changing, attributes: { class: 'state_changing' } },
    ]);
  });

  it('reports zero for a class with no template', () => {
    const { meter, collect } = fakeMeter();
    const passiveOnly = library.templates.filter((t) => t.class === 'passive');
    createPlanTemplatesTotalMetric(meter, passiveOnly);
    expect(collect().map((o) => o.value)).toEqual([passiveOnly.length, 0, 0]);
  });
});
