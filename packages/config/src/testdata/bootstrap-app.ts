// Fixture: a minimal app bootstrap run in a child process by bootstrap.test.ts. It reads the real
// process.env, so the parent controls the environment, and prints only key names on success.
import { zPort, zSecret } from "../coerce.js";
import { defineConfig } from "../env.js";
import { baseEnvSchema, databaseEnvShape } from "../schema.js";

const config = defineConfig(baseEnvSchema.extend({ ...databaseEnvShape, PORT: zPort(), API_TOKEN: zSecret() }));

process.stdout.write(`${JSON.stringify({ started: true, keys: Object.keys(config).sort() })}\n`);
