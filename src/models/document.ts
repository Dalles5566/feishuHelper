/**
 * Document-related TypeScript interfaces and types.
 *
 * Defines the data structures for test documents, test cases, Markdown
 * documents, and user manuals produced by the Doc Generator.
 *
 * Requirements: 5.3
 */

// ---------------------------------------------------------------------------
// Test Case
// ---------------------------------------------------------------------------

/**
 * A single step within a test case.
 */
export interface TestStep {
  order: number;
  action: string;
  expectedOutcome?: string;
}

/**
 * A test case within a test document.
 */
export interface TestCase {
  id: string;
  title: string;
  type: 'positive' | 'negative' | 'boundary';
  preconditions: string[];
  steps: TestStep[];
  expectedResult: string;
}

// ---------------------------------------------------------------------------
// Test Document
// ---------------------------------------------------------------------------

/**
 * A test document generated for a task after it passes AI verification.
 * Contains test cases derived from the task's acceptance criteria.
 */
export interface TestDocument {
  taskId: string;
  testCases: TestCase[];
  generatedAt: string;
}

// ---------------------------------------------------------------------------
// MD Document
// ---------------------------------------------------------------------------

/**
 * A section within a Markdown document (supports nesting).
 */
export interface DocSection {
  heading: string;
  /** Heading level: 1 = H1, 2 = H2, etc. */
  level: number;
  content: string;
  subsections?: DocSection[];
}

/**
 * A Markdown document managed by the Doc Generator.
 */
export interface MDDocument {
  id: string;
  title: string;
  sections: DocSection[];
  version: string;
  lastUpdated: string;
}

/**
 * The content used to update an existing MD document.
 */
export interface DocUpdateContent {
  /** Heading of the section to update or create. */
  sectionHeading: string;
  content: string;
  /** If provided, the section is inserted after this heading. */
  insertAfter?: string;
}

// ---------------------------------------------------------------------------
// User Manual
// ---------------------------------------------------------------------------

/**
 * A table-of-contents entry in the user manual.
 */
export interface TocEntry {
  title: string;
  anchor: string;
  /** Nesting level (0 = top-level chapter). */
  level: number;
  children?: TocEntry[];
}

/**
 * A cross-reference between two sections in the user manual.
 */
export interface CrossReference {
  fromSection: string;
  toSection: string;
  description: string;
}

/**
 * A compiled user manual built from multiple MD documents.
 */
export interface UserManual {
  id: string;
  title: string;
  tableOfContents: TocEntry[];
  sections: DocSection[];
  crossReferences: CrossReference[];
  /** Semver-style version string. */
  version: string;
  /** ISO 8601 timestamp of the last compilation. */
  compiledAt: string;
  /** IDs of the MD documents included in this manual. */
  sourceDocIds: string[];
}

// ---------------------------------------------------------------------------
// Document type discriminator
// ---------------------------------------------------------------------------

/**
 * The type of a document stored in the documents table.
 */
export type DocType = 'test_doc' | 'md_doc' | 'user_manual';
