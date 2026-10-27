// ESLint rule `blackwing/no-literal-ui-strings` (#272, CONTEXT_PACK §5). Shell components render
// every user-facing string through `t()` from apps/web/src/lib/i18n.ts, so the English copy lives
// in apps/web/src/messages/en.json and the eventual translation pass stays additive.
//
// Reported, in JSX only:
//   <span>Runs</span>                 bare text
//   <span>{'Runs'}</span>             string literal child
//   <button aria-label="Close">       literal value of an accessible-name or text attribute
//   <button aria-label={'Close'}>
// Not reported: whitespace-only text (`{' '}`), decorative attributes such as aria-hidden, and any
// expression that is not a bare string literal (`t('common.close')`, `value`).

/** Attributes that carry user-visible or screen-reader text. */
const TEXT_ATTRIBUTES = new Set(['aria-label', 'aria-description', 'title', 'alt', 'placeholder']);

const MESSAGE =
  'Hard-coded UI string "{{text}}". Add a key to apps/web/src/messages/en.json and render it with t().';

/**
 * The fields of the ESTree/JSX nodes this rule reads. Typed by hand so the rule stays free of `any`
 * (CONTEXT_PACK §10) without pulling in a parser-types package.
 * @typedef {{
 *   type: string,
 *   value?: unknown,
 *   name?: unknown,
 *   expression?: unknown,
 *   consequent?: unknown,
 *   alternate?: unknown,
 * }} SyntaxNode
 */

/** @param {unknown} node @returns {SyntaxNode | null} */
function asNode(/** @type {unknown} */ node) {
  return typeof node === 'object' && node !== null && 'type' in node
    ? /** @type {SyntaxNode} */ (node)
    : null;
}

/** @param {unknown} node @returns {node is SyntaxNode & { value: string }} */
function isStringLiteral(/** @type {unknown} */ node) {
  const syntax = asNode(node);
  return syntax !== null && syntax.type === 'Literal' && typeof syntax.value === 'string';
}

/**
 * The string literals an expression can produce: the literal itself, or the literals on both
 * branches of a conditional (`on ? 'Open' : 'Close'`). Anything else (calls such as `t()`) yields none.
 * @param {unknown} expression
 * @returns {(SyntaxNode & { value: string })[]}
 */
function literalsOf(expression) {
  if (isStringLiteral(expression)) return [expression];
  const syntax = asNode(expression);
  if (syntax !== null && syntax.type === 'ConditionalExpression') {
    return [...literalsOf(syntax.consequent), ...literalsOf(syntax.alternate)];
  }
  return [];
}

/** @type {import('eslint').Rule.RuleModule} */
export const noLiteralUiStrings = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Forbid hard-coded user-facing strings in shell components; use t() keys',
    },
    schema: [],
    messages: { hardCoded: MESSAGE },
  },
  create(context) {
    /** @param {unknown} node the reported node, the JSX text or literal that holds `text` @param {string} text */
    const reportIfText = (node, text) => {
      if (!/\S/.test(text)) return;
      context.report({
        node: /** @type {import('estree').Node} */ (/** @type {unknown} */ (node)),
        messageId: 'hardCoded',
        data: { text: text.trim() },
      });
    };

    return {
      JSXText(/** @type {unknown} */ node) {
        const text = asNode(node)?.value;
        if (typeof text === 'string') reportIfText(node, text);
      },
      'JSXElement > JSXExpressionContainer, JSXFragment > JSXExpressionContainer'(
        /** @type {unknown} */ node,
      ) {
        for (const literal of literalsOf(asNode(node)?.expression)) {
          reportIfText(literal, literal.value);
        }
      },
      JSXAttribute(/** @type {unknown} */ node) {
        const name = asNode(asNode(node)?.name);
        if (name?.type !== 'JSXIdentifier' || typeof name.name !== 'string') return;
        if (!TEXT_ATTRIBUTES.has(name.name)) return;
        const value = asNode(asNode(node)?.value);
        if (value === null) return;
        const candidates =
          value.type === 'Literal'
            ? literalsOf(value)
            : value.type === 'JSXExpressionContainer'
              ? literalsOf(value.expression)
              : [];
        for (const literal of candidates) reportIfText(literal, literal.value);
      },
    };
  },
};
