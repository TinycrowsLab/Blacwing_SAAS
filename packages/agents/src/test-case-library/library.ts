import { libraryVersion, templates as version100 } from './1.0.0/index.js';
import { TestCaseLibraryError, type Template, validateTemplateLibrary } from './template.js';

/**
 * The loader (PLANNER-002, #428). Each library version is registered here once. A caller asks for a version by
 * name (the version a run pinned, §8.9) and gets back that version's templates, validated against the template
 * schema and frozen. A broken template throws, so a bad library fails CI before any run can plan from it.
 */

/** The version a new run plans from. Pinned onto the run manifest. */
export const TEST_CASE_LIBRARY_VERSION = libraryVersion;

/** A validated, immutable library version. */
export interface TestCaseLibrary {
  readonly libraryVersion: string;
  readonly templates: readonly Template[];
}

const LIBRARY_SOURCES: ReadonlyMap<string, readonly unknown[]> = new Map([
  [libraryVersion, version100],
]);

/** Freezes a template and its arrays, so nothing downstream can edit a shipped version in place. */
function freezeTemplate(template: Template): Template {
  return Object.freeze({
    ...template,
    owaspRefs: Object.freeze([...template.owaspRefs]),
    wstgRefs: Object.freeze([...template.wstgRefs]),
    asvsRefs: Object.freeze([...template.asvsRefs]),
    cweCandidates: Object.freeze([...template.cweCandidates]),
    applicableModes: Object.freeze([...template.applicableModes]),
  });
}

/**
 * Loads and validates one library version. Unknown versions fail closed.
 *
 * @throws {TestCaseLibraryError} `TEST_CASE_LIBRARY_INVALID` for an unknown version or any invalid template.
 */
export function loadTestCaseLibrary(version: string = TEST_CASE_LIBRARY_VERSION): TestCaseLibrary {
  const source = LIBRARY_SOURCES.get(version);
  if (source === undefined) {
    throw new TestCaseLibraryError([`libraryVersion: unknown test-case library version`]);
  }
  const templates = validateTemplateLibrary(source).map((template) => freezeTemplate(template));
  return Object.freeze({ libraryVersion: version, templates: Object.freeze(templates) });
}
