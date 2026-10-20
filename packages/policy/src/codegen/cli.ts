import { readFileSync, writeFileSync } from 'node:fs';

import { renderSchemaTypes } from './render.js';

// Regenerates src/schema.types.ts from schema/blackwing.cedarschema (POLICY-001).
const schemaUrl = new URL('../../schema/blackwing.cedarschema', import.meta.url);
const outUrl = new URL('../schema.types.ts', import.meta.url);

writeFileSync(outUrl, renderSchemaTypes(readFileSync(schemaUrl, 'utf8')));
