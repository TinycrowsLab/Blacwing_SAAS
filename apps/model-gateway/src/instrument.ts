import { initTelemetry } from '@blackwing/telemetry';

// Starts the OpenTelemetry SDK with the auto-instrumentation subset (OBS-002, #299). It must stay the first
// import of the entrypoint, so instrumented libraries are patched before anything loads them.
initTelemetry({ serviceName: 'model-gateway' });
