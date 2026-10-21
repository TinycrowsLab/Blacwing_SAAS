// ESLint rule `blackwing/no-raw-tenant-db` (TENANT-002, CONTEXT_PACK §7, §8.6, §8.11).
//
// A table that carries `tenant_id` (declared with `tenantIdColumn()` from @blackwing/db, the DB-004
// tenant-table tag, or a literal `tenant_id` column) may only be queried through the handle that
// `withTenant` passes to its callback. Querying it from the raw `db`/pool/`Database` is reported:
//
//   db.select().from(widgets)            // error: raw handle
//   withTenant(db, id, (tx) => tx.select().from(widgets))   // fine: tx is a TenantTx
//
// How it decides (type-aware, so it needs the project service):
//   - tenant table: the argument of `from/insert/update/delete/*Join(...)` resolves, through the
//     type checker, to a declaration that holds `tenantIdColumn(` or the `tenant_id` column name;
//   - raw handle: the object the query starts from (`X.select()`, `X.insert(t)`, ...) has a type
//     without the `TenantTx` brand (`drizzle({ client })` is judged by its client). `SystemTx`
//     (withSystem) and `any` are not reported.
//
// Exemptions: tables without `tenant_id` (users, ...); `withSystem` handles; migration code and
// the owner pool (configured per file in eslint.config.mjs); and an explicit, justified annotation
// on the line above the query: `// blackwing:allow-raw-tenant-db <reason>`.
//
// Limitations (documented in docs/architecture/tenant-data-access.md): dynamically built queries,
// `db.execute(sql...)` and relational `db.query.<table>` access cannot be resolved statically. The
// run-time `assertTenantScope` and RLS (DB-003) are the backstop for those.

import ts from 'typescript';

/** Drizzle builder methods that take a table as their first argument. */
const TABLE_METHODS = new Set([
  'from',
  'insert',
  'update',
  'delete',
  'innerJoin',
  'leftJoin',
  'rightJoin',
  'fullJoin',
  'crossJoin',
]);
/** Calls that start a read builder, e.g. `db.select().from(t)`. */
const READ_STARTERS = new Set(['select', 'selectDistinct', 'selectDistinctOn', 'with']);
/** Methods taking the table from the receiver chain rather than from a `select()` starter. */
const WRITE_METHODS = new Set(['insert', 'update', 'delete']);

const ALLOW_ANNOTATION = /blackwing:allow-raw-tenant-db\s+\S+/;
const TENANT_BRAND = 'tenantTxBrand';
const SYSTEM_BRAND = 'systemTxBrand';

/** @typedef {{ program?: ts.Program, esTreeNodeToTSNodeMap?: { get(node: unknown): ts.Node } }} ParserServices */

/** @type {import('eslint').Rule.RuleModule} */
export const noRawTenantDb = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Forbid querying a tenant-scoped table (one with tenant_id) from the raw db/pool outside withTenant',
    },
    schema: [],
    messages: {
      rawTenantDb:
        'Table "{{table}}" is tenant-scoped (tenant_id): query it through the handle passed by withTenant(db, tenantId, (tx) => ...) and type repositories as TenantScopedDb, never the raw db/pool. withSystem and migrations need `// blackwing:allow-raw-tenant-db <reason>`. See docs/architecture/tenant-data-access.md.',
    },
  },
  create(context) {
    const services = /** @type {ParserServices} */ (
      /** @type {unknown} */ (context.sourceCode.parserServices) ?? {}
    );
    const program = services.program;
    const nodeMap = services.esTreeNodeToTSNodeMap;
    if (!program || !nodeMap) return {};
    const tsNodes = nodeMap;
    const checker = program.getTypeChecker();
    /** @type {Map<ts.Declaration, boolean>} */
    const tenantDeclarations = new Map();

    /** Whether a declaration is a tenant-tagged table definition. */
    function isTenantDeclaration(/** @type {ts.Declaration} */ declaration) {
      const cached = tenantDeclarations.get(declaration);
      if (cached !== undefined) return cached;
      const text = declaration.getText();
      const tagged = /\btenantIdColumn\s*\(/.test(text) || /['"`]tenant_id['"`]/.test(text);
      tenantDeclarations.set(declaration, tagged);
      return tagged;
    }

    /** The tenant table an identifier refers to, if any (follows imports and re-exports). */
    function tenantTableOf(/** @type {import('estree').Node} */ node) {
      if (node.type !== 'Identifier') return undefined;
      const tsNode = tsNodes.get(node);
      let symbol = checker.getSymbolAtLocation(tsNode);
      if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
      const declaration = symbol?.valueDeclaration;
      return declaration && isTenantDeclaration(declaration) ? node.name : undefined;
    }

    /** Whether the handle's type is a raw database/pool (no TenantTx/SystemTx brand, not any). */
    function isRawHandle(/** @type {import('estree').Node} */ node) {
      // `drizzle({ client: tx })` wraps a pool/transaction: the wrapper is as raw as its client.
      if (
        node.type === 'CallExpression' &&
        node.callee.type === 'Identifier' &&
        node.callee.name === 'drizzle' &&
        node.arguments[0]?.type === 'ObjectExpression'
      ) {
        const client = node.arguments[0].properties.find(
          (p) => p.type === 'Property' && p.key.type === 'Identifier' && p.key.name === 'client',
        );
        if (client?.type === 'Property') return isRawHandle(client.value);
      }
      const type = checker.getTypeAtLocation(tsNodes.get(node));
      if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return false;
      const branded = (/** @type {ts.Type} */ t) =>
        t
          .getProperties()
          .some((p) => p.name.includes(TENANT_BRAND) || p.name.includes(SYSTEM_BRAND));
      const members = type.isUnionOrIntersection() ? type.types : [type];
      return !members.some((member) => branded(member));
    }

    /** The object a query builder chain starts from, e.g. `db` in `db.select().from(t)`. */
    function receiverOf(
      /** @type {import('estree').CallExpression} */ call,
      /** @type {string} */ method,
    ) {
      if (call.callee.type !== 'MemberExpression') return undefined;
      let node = call.callee.object;
      if (WRITE_METHODS.has(method)) return node;
      // Walk back through `.where()/.from()/...` to the `select()`-style starter.
      while (node.type === 'CallExpression' && node.callee.type === 'MemberExpression') {
        const name = node.callee.property.type === 'Identifier' ? node.callee.property.name : '';
        node = node.callee.object;
        if (READ_STARTERS.has(name)) {
          // `db.with(cte).select()`: the handle is the object before `.with`.
          if (
            node.type === 'CallExpression' &&
            node.callee.type === 'MemberExpression' &&
            node.callee.property.type === 'Identifier' &&
            node.callee.property.name === 'with'
          ) {
            node = node.callee.object;
          }
          return node;
        }
      }
      return undefined;
    }

    /** Whether a justified allow annotation sits on the line above the statement of `node`. */
    function isAnnotated(/** @type {import('estree').Node} */ node) {
      let statement = /** @type {import('eslint').Rule.Node} */ (node);
      for (;;) {
        /** @type {import('eslint').Rule.Node | null} */
        const parent = statement.parent;
        if (!parent || parent.type === 'Program' || parent.type === 'BlockStatement') break;
        statement = parent;
      }
      return context.sourceCode
        .getCommentsBefore(statement)
        .some((comment) => ALLOW_ANNOTATION.test(comment.value));
    }

    return {
      CallExpression(call) {
        if (call.callee.type !== 'MemberExpression' || call.callee.property.type !== 'Identifier') {
          return;
        }
        const method = call.callee.property.name;
        const [table] = call.arguments;
        if (!TABLE_METHODS.has(method) || !table) return;
        const tableName = tenantTableOf(table);
        if (tableName === undefined) return;
        const receiver = receiverOf(call, method);
        if (!receiver || !isRawHandle(receiver) || isAnnotated(call)) return;
        context.report({ node: call, messageId: 'rawTenantDb', data: { table: tableName } });
      },
    };
  },
};
