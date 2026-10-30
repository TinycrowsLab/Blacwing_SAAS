import { initTelemetry } from '@blackwing/telemetry';

// Node runtime only (OBS-002, #299). Started from the Next.js instrumentation hook (`src/instrumentation.ts`).
initTelemetry({ serviceName: 'web' });
