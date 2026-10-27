import { z } from 'zod';

import { AppError } from '@blackwing/errors';

import type { OpenBaoClient } from '@blackwing/secrets';

/** OpenBao KV v2 returns the secret map under `data.data`; only `client_secret` is read. */
const kvSecretSchema = z.object({
  data: z.object({ client_secret: z.string().min(1) }),
});

/**
 * Returns a reader for the Keycloak admin client secret stored in OpenBao (IAM-002, CONTEXT_PACK §8 #7). The
 * admin client calls it on first use and again after Keycloak rejects its token, so a rotated secret is picked
 * up without a restart. The value is never logged and never placed in an error.
 */
export function createOpenBaoClientSecretReader(
  openBao: OpenBaoClient,
  secretPath: string,
): () => Promise<string> {
  return async () => {
    const response = await openBao.request('GET', secretPath);
    const parsed = kvSecretSchema.safeParse(response.data);
    if (!parsed.success) {
      throw new AppError(
        'CONFIG_INVALID',
        'The Keycloak organisation admin client secret is missing from OpenBao',
      );
    }
    return parsed.data.data.client_secret;
  };
}
