import { schemaToJsonWithResolvedTypes } from '@cedar-policy/cedar-wasm/nodejs';

/**
 * Renders `src/schema.types.ts` from the Cedar schema (POLICY-001). The output is deterministic
 * (sorted keys, fixed formatting) so a test can regenerate it and compare it verbatim with the
 * committed file: a schema change without regenerated types fails CI.
 *
 * Value shapes follow the Cedar JSON entity/context format, so a well-typed value can be passed
 * to the engine unchanged: `datetime` is `{ __extn: { fn: 'datetime', arg } }` and an entity
 * reference is `{ __entity: { type, id } }`.
 */

interface CedarTypeJson {
  readonly type?: string;
  readonly name?: string;
  readonly element?: CedarTypeJson;
  readonly attributes?: Readonly<Record<string, CedarAttrJson>>;
}

interface CedarAttrJson extends CedarTypeJson {
  readonly required?: boolean;
}

interface EntityTypeJson {
  readonly shape?: CedarTypeJson;
  readonly enum?: readonly string[];
}

interface AppliesToJson {
  readonly principalTypes?: readonly string[];
  readonly resourceTypes?: readonly string[];
  readonly context?: CedarTypeJson;
}

interface NamespaceJson {
  readonly commonTypes?: Readonly<Record<string, CedarTypeJson>>;
  readonly entityTypes?: Readonly<Record<string, EntityTypeJson>>;
  readonly actions?: Readonly<Record<string, { readonly appliesTo?: AppliesToJson }>>;
}

/** Thrown when the schema cannot be parsed or uses a construct the generator does not model. */
export class SchemaCodegenError extends Error {
  override readonly name = 'SchemaCodegenError';
}

const sorted = <T>(record: Readonly<Record<string, T>> | undefined): [string, T][] =>
  Object.entries(record ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

const localName = (qualified: string): string => qualified.split('::').at(-1) ?? qualified;

/** TypeScript name for a common type, entity attribute shape or enum id. */
const commonTypeName = (qualified: string): string => localName(qualified);
const attrsTypeName = (qualified: string): string => `${localName(qualified)}Attrs`;
const enumIdTypeName = (qualified: string): string => `${localName(qualified)}Id`;
const constName = (qualified: string): string =>
  `${localName(qualified)
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toUpperCase()}_IDS`;

interface Model {
  readonly commonTypes: ReadonlyMap<string, CedarTypeJson>;
  readonly enums: ReadonlyMap<string, readonly string[]>;
  readonly entities: ReadonlyMap<string, CedarTypeJson>;
  readonly actions: readonly {
    readonly uid: string;
    readonly principalTypes: readonly string[];
    readonly resourceTypes: readonly string[];
    readonly context: string;
  }[];
}

function buildModel(json: Readonly<Record<string, NamespaceJson>>): Model {
  const commonTypes = new Map<string, CedarTypeJson>();
  const enums = new Map<string, readonly string[]>();
  const entities = new Map<string, CedarTypeJson>();
  const actions: Model['actions'][number][] = [];
  for (const [ns, def] of sorted(json)) {
    const q = (n: string): string => (ns === '' ? n : `${ns}::${n}`);
    for (const [name, type] of sorted(def.commonTypes)) commonTypes.set(q(name), type);
    for (const [name, entity] of sorted(def.entityTypes)) {
      if (entity.enum !== undefined) enums.set(q(name), entity.enum);
      else entities.set(q(name), entity.shape ?? { type: 'Record', attributes: {} });
    }
    for (const [name, action] of sorted(def.actions)) {
      const appliesTo = action.appliesTo;
      const context = appliesTo?.context?.type;
      if (context === undefined || appliesTo?.context?.attributes !== undefined) {
        throw new SchemaCodegenError(`action ${q(name)} must use a named common context type`);
      }
      actions.push({
        uid: `${q('Action')}::${JSON.stringify(name)}`,
        principalTypes: [...(appliesTo?.principalTypes ?? [])].sort(),
        resourceTypes: [...(appliesTo?.resourceTypes ?? [])].sort(),
        context,
      });
    }
  }
  return { commonTypes, enums, entities, actions };
}

function renderType(t: CedarTypeJson, model: Model, indent: string): string {
  switch (t.type) {
    case 'String':
      return 'string';
    case 'Long':
      return 'number';
    case 'Bool':
    case 'Boolean':
      return 'boolean';
    case 'datetime':
      return 'CedarDatetime';
    case 'Set':
      if (t.element === undefined) throw new SchemaCodegenError('Set without element type');
      return `readonly ${wrapForArray(renderType(t.element, model, indent))}[]`;
    case 'Entity': {
      const name = t.name ?? '';
      if (model.enums.has(name)) return `CedarEntityRef<'${name}', ${enumIdTypeName(name)}>`;
      if (model.entities.has(name)) return `CedarEntityRef<'${name}'>`;
      throw new SchemaCodegenError(`unknown entity type ${name}`);
    }
    case 'Record':
      return renderRecord(t, model, indent);
    default: {
      const name = t.type ?? '';
      if (model.commonTypes.has(name)) return commonTypeName(name);
      throw new SchemaCodegenError(`unsupported Cedar type ${JSON.stringify(t)}`);
    }
  }
}

const wrapForArray = (ts: string): string => (/[\s|]/.test(ts) ? `(${ts})` : ts);

function renderRecord(t: CedarTypeJson, model: Model, indent: string): string {
  const inner = `${indent}  `;
  const lines = sorted(t.attributes).map(
    ([name, attr]) =>
      `${inner}readonly ${name}${attr.required === false ? '?' : ''}: ${renderType(attr, model, inner)};`,
  );
  return lines.length === 0 ? '{}' : `{\n${lines.join('\n')}\n${indent}}`;
}

const quoteList = (values: readonly string[]): string => values.map((v) => `'${v}'`).join(', ');

function renderAttributeList(name: string, t: CedarTypeJson): string {
  const keys = sorted(t.attributes).map(([k]) => k);
  return `  ${name}: [${quoteList(keys)}],`;
}

/** Renders the TypeScript module for the given Cedar schema text. */
export function renderSchemaTypes(schemaText: string): string {
  const answer = schemaToJsonWithResolvedTypes(schemaText);
  if (answer.type !== 'success') {
    throw new SchemaCodegenError(
      `schema does not parse: ${answer.errors.map((e) => e.message).join('; ')}`,
    );
  }
  const model = buildModel(answer.json);
  const out: string[] = [
    '// GENERATED from schema/blackwing.cedarschema by src/codegen (POLICY-001). Do not edit by hand:',
    '// run `pnpm --filter @blackwing/policy gen:schema-types`. A test fails when this file drifts.',
    '',
    '/** A Cedar `datetime` extension value in the Cedar JSON format (build with `cedarDatetime`). */',
    'export interface CedarDatetime {',
    "  readonly __extn: { readonly fn: 'datetime'; readonly arg: string };",
    '}',
    '',
    '/** A Cedar entity reference in the Cedar JSON format. */',
    'export interface CedarEntityRef<T extends string, I extends string = string> {',
    '  readonly __entity: { readonly type: T; readonly id: I };',
    '}',
  ];
  for (const [name, values] of model.enums) {
    out.push('', `/** Members of the Cedar enum entity type \`${name}\`. */`);
    out.push(`export const ${constName(name)} = [${quoteList(values)}] as const;`);
    out.push(`export type ${enumIdTypeName(name)} = (typeof ${constName(name)})[number];`);
  }
  for (const [name, t] of model.commonTypes) {
    out.push('', `/** Cedar common type \`${name}\`. */`);
    out.push(`export interface ${commonTypeName(name)} ${renderType(t, model, '')}`);
  }
  for (const [name, t] of model.entities) {
    out.push('', `/** Attributes of the Cedar entity type \`${name}\`. */`);
    out.push(`export interface ${attrsTypeName(name)} ${renderRecord(t, model, '')}`);
  }

  out.push('', '/** Attributes of every entity type, keyed by its fully qualified Cedar name. */');
  out.push('export interface EntityAttrsByType {');
  for (const [name] of model.entities) out.push(`  '${name}': ${attrsTypeName(name)};`);
  out.push('}');
  out.push('', '/** Fully qualified Cedar name of every (non-enum) entity type. */');
  out.push('export type EntityTypeName = keyof EntityAttrsByType;');

  out.push(
    '',
    '/** Every action UID with the principal, resource and context types it applies to. */',
  );
  out.push('export interface ActionSignatures {');
  for (const a of model.actions) {
    out.push(`  '${a.uid}': {`);
    out.push(`    principal: ${a.principalTypes.map((p) => `'${p}'`).join(' | ')};`);
    out.push(`    resource: ${a.resourceTypes.map((r) => `'${r}'`).join(' | ')};`);
    out.push(`    context: ${commonTypeName(a.context)};`);
    out.push('  };');
  }
  out.push('}');
  out.push('', '/** A declared action UID, e.g. `Egress::Action::"httpRequest"`. */');
  out.push('export type ActionUid = keyof ActionSignatures;');

  out.push(
    '',
    '/** Declared actions, in a runtime form the parity tests and the engine can iterate. */',
  );
  out.push('export const ACTIONS = {');
  for (const a of model.actions) {
    out.push(`  '${a.uid}': {`);
    out.push(`    principalTypes: [${quoteList(a.principalTypes)}],`);
    out.push(`    resourceTypes: [${quoteList(a.resourceTypes)}],`);
    out.push(`    context: '${commonTypeName(a.context)}',`);
    out.push('  },');
  }
  out.push('} as const;');

  out.push('', '/** Attribute names of every entity type and record common type (sorted). */');
  out.push('export const SCHEMA_ATTRIBUTES = {');
  for (const [name, t] of model.commonTypes) {
    if (t.type === 'Record') out.push(renderAttributeList(commonTypeName(name), t));
  }
  for (const [name, t] of model.entities) out.push(renderAttributeList(attrsTypeName(name), t));
  out.push('} as const;', '');
  return out.join('\n');
}
