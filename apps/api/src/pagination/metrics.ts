import { Counter, exponentialBuckets, Histogram, Registry } from 'prom-client';

import { MAX_PAGE_LIMIT } from '@blackwing/contracts';

const PAGE_SIZE_BUCKET_COUNT = 8;
/** 0, then 1 doubling up to 128, then the maximum page size. */
const PAGE_SIZE_BUCKETS = [0, ...exponentialBuckets(1, 2, PAGE_SIZE_BUCKET_COUNT), MAX_PAGE_LIMIT];

/** List metrics (API-005): `list_page_size` and `list_requests_total{route}`. */
export interface ListMetrics {
  readonly registry: Registry;
  readonly pageSize: Histogram;
  readonly requests: Counter<'route'>;
  record(route: string, size: number): void;
}

export function createListMetrics(registry: Registry = new Registry()): ListMetrics {
  const pageSize = new Histogram({
    name: 'list_page_size',
    help: 'Items returned per list page.',
    buckets: PAGE_SIZE_BUCKETS,
    registers: [registry],
  });
  const requests = new Counter({
    name: 'list_requests_total',
    help: 'List page requests served, by route template.',
    labelNames: ['route'],
    registers: [registry],
  });
  return {
    registry,
    pageSize,
    requests,
    record(route, size) {
      requests.inc({ route });
      pageSize.observe(size);
    },
  };
}
