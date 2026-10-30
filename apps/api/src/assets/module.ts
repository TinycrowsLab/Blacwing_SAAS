import { type DynamicModule, Module } from '@nestjs/common';

import {
  AssetRepository as AssetListReader,
  type Database,
  TenantHaltRepository,
} from '@blackwing/db';
import {
  DEFAULT_VERIFICATION_POLICY,
  type VerificationPolicy,
  type VerificationProbe,
} from '@blackwing/domain';

import { AssetsController } from './controller.js';
import { HttpFileProbe } from './http-file-probe.js';
import { createAssetMetrics, type AssetMetrics } from './metrics.js';
import { createCedarAssetPolicy } from './policy.js';
import { AssetRepository } from './repository.js';
import { AssetService } from './service.js';
import { ASSET_METRICS, ASSET_SERVICE, ASSET_VERIFICATION_SERVICE } from './tokens.js';
import { AssetVerificationRepository } from './verification-repository.js';
import { AssetVerificationService } from './verification-service.js';
import { AssetVerificationController } from './verification.controller.js';
import { API_LOGGER } from '../bootstrap/tokens.js';

import type { QuotaEnforcer } from '../quota/service.js';
import type { VerificationMethod } from '@blackwing/contracts';
import type { Logger } from '@blackwing/logger';
import type { Registry } from 'prom-client';

export interface AssetsModuleOptions {
  /** The app role's database handle (`createDatabase(pool)`). Every query runs under `withTenant`. */
  readonly database: Database;
  /** The API's metrics registry, so the asset counters appear on `/metrics`. */
  readonly registry: Registry;
  /**
   * The deployed verification probes (ASSET-005 DNS, ASSET-006 HTTP). One per method; a method without a probe
   * answers `503` on check, so an unprobed asset can never become verified. Unset, the HTTP-file probe is deployed
   * (ASSET-006) and is the only probe; pass a list to replace it.
   */
  readonly verificationProbes?: readonly VerificationProbe[];
  /** Overrides of the verification tunables (`bw.asset.*`); unset keys keep the issue's defaults. */
  readonly verificationPolicy?: Partial<VerificationPolicy>;
  /** The plan quota enforcer (TENANT-009). Required: an asset create is never unchecked against the plan. */
  readonly quota: QuotaEnforcer;
}

/** The probes keyed by method. Two probes for one method would make the choice silent, so that is refused. */
function probesByMethod(
  probes: readonly VerificationProbe[],
): ReadonlyMap<VerificationMethod, VerificationProbe> {
  const byMethod = new Map<VerificationMethod, VerificationProbe>();
  for (const probe of probes) {
    if (byMethod.has(probe.method)) throw new Error(`two verification probes for ${probe.method}`);
    byMethod.set(probe.method, probe);
  }
  return byMethod;
}

/**
 * The asset registry module (ASSET-002, ASSET-003): `/v1/assets`. Mounted by the API bootstrap through
 * `createApiApp({ imports: [AssetsModule.forRoot(...)] })`; it needs the tenant guard (`tenantPrincipalSource`)
 * to be installed, otherwise every route answers 401 (fail closed).
 */
@Module({ controllers: [AssetsController, AssetVerificationController] })
export class AssetsModule {
  static forRoot(options: AssetsModuleOptions): DynamicModule {
    return {
      module: AssetsModule,
      providers: [
        {
          provide: ASSET_METRICS,
          useFactory: (): AssetMetrics => createAssetMetrics(options.registry),
        },
        {
          provide: ASSET_SERVICE,
          inject: [ASSET_METRICS, API_LOGGER],
          useFactory: (metrics: AssetMetrics, logger: Logger) =>
            new AssetService({
              repository: new AssetRepository({ db: options.database }),
              projections: new AssetListReader({ db: options.database }),
              policy: createCedarAssetPolicy(),
              quota: options.quota,
              metrics,
              logger,
            }),
        },
        {
          provide: ASSET_VERIFICATION_SERVICE,
          inject: [ASSET_METRICS, API_LOGGER],
          useFactory: (metrics: AssetMetrics, logger: Logger) =>
            new AssetVerificationService({
              repository: new AssetRepository({ db: options.database }),
              halts: new TenantHaltRepository({ db: options.database }),
              verifications: new AssetVerificationRepository(),
              policy: createCedarAssetPolicy(),
              probes: probesByMethod(
                options.verificationProbes ?? [
                  new HttpFileProbe({
                    record: (result, reason) => {
                      metrics.verificationHttpFile(result, reason);
                    },
                    logger,
                  }),
                ],
              ),
              settings: { ...DEFAULT_VERIFICATION_POLICY, ...options.verificationPolicy },
              metrics,
              logger,
            }),
        },
      ],
    };
  }
}
