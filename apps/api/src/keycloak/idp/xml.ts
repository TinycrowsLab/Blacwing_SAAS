import { SaxesParser } from 'saxes';

import { ValidationError } from '@blackwing/errors';

/**
 * XML for SAML metadata (IAM-004). The parser never resolves external entities and refuses any DTD or entity
 * declaration outright (XXE, CWE-611; entity expansion, CWE-776): SAML metadata needs neither. Size and element
 * counts are bounded before the tree is built, so a hostile document fails fast with a clear error.
 */

/** Largest metadata document accepted, in UTF-8 bytes (customer uploads and fetched metadata). */
export const MAX_XML_BYTES = 262_144;
const MAX_ELEMENTS = 5_000;
const MAX_DEPTH = 64;

/** A parsed element. Attributes without a namespace are keyed by local name. */
export interface XmlElement {
  readonly uri: string;
  readonly local: string;
  readonly attributes: ReadonlyMap<string, string>;
  readonly children: readonly XmlElement[];
  /** The concatenated character data directly inside this element. */
  readonly text: string;
}

interface MutableElement {
  uri: string;
  local: string;
  attributes: Map<string, string>;
  children: MutableElement[];
  text: string;
}

/** Parses one XML document into an element tree, or throws a `ValidationError` that names the problem. */
export function parseXmlSafely(xml: string): XmlElement {
  if (Buffer.byteLength(xml, 'utf8') > MAX_XML_BYTES) {
    throw new ValidationError('XML document is too large', {
      detail: `the document must be at most ${MAX_XML_BYTES} bytes`,
    });
  }
  if (/<!\s*(?:DOCTYPE|ENTITY)/i.test(xml)) {
    throw new ValidationError('XML document declares a DTD or entities', {
      detail: 'DTDs and entity declarations are not accepted in SAML metadata',
    });
  }

  const parser = new SaxesParser({ xmlns: true });
  const stack: MutableElement[] = [];
  let root: MutableElement | undefined;
  let elements = 0;
  let failure: string | undefined;

  parser.on('error', (error) => {
    failure ??= error.message;
  });
  parser.on('opentag', (tag) => {
    elements += 1;
    if (elements > MAX_ELEMENTS) failure ??= 'too many elements';
    if (stack.length >= MAX_DEPTH) failure ??= 'nested too deeply';
    const attributes = new Map<string, string>();
    for (const attribute of Object.values(tag.attributes)) {
      if (attribute.uri === '') attributes.set(attribute.local, attribute.value);
    }
    const element: MutableElement = {
      uri: tag.uri,
      local: tag.local,
      attributes,
      children: [],
      text: '',
    };
    const parent = stack[stack.length - 1];
    if (parent === undefined) {
      if (root !== undefined) failure ??= 'more than one root element';
      root = element;
    } else {
      parent.children.push(element);
    }
    stack.push(element);
  });
  parser.on('closetag', () => {
    stack.pop();
  });
  parser.on('text', (text) => {
    const current = stack[stack.length - 1];
    if (current !== undefined) current.text += text;
  });

  try {
    parser.write(xml).close();
  } catch (error) {
    failure ??= error instanceof Error ? error.message : 'malformed XML';
  }
  if (failure === undefined && root === undefined) failure = 'no root element';
  if (failure !== undefined || root === undefined) {
    throw new ValidationError('XML document is malformed', {
      detail: `the document could not be parsed: ${failure ?? 'no root element'}`,
    });
  }
  return freeze(root);
}

function freeze(element: MutableElement): XmlElement {
  return {
    uri: element.uri,
    local: element.local,
    attributes: element.attributes,
    children: element.children.map((child) => freeze(child)),
    text: element.text,
  };
}

/** Direct children with the given namespace and local name. */
export function childrenNamed(parent: XmlElement, uri: string, local: string): XmlElement[] {
  return parent.children.filter((child) => child.uri === uri && child.local === local);
}

/** All descendants (depth first) with the given namespace and local name. */
export function descendantsNamed(parent: XmlElement, uri: string, local: string): XmlElement[] {
  return parent.children.flatMap((child) => [
    ...(child.uri === uri && child.local === local ? [child] : []),
    ...descendantsNamed(child, uri, local),
  ]);
}
