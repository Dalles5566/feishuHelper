/**
 * Verification-related TypeScript interfaces and types.
 *
 * Defines the data structures for code verification reports, code context
 * inputs, and discrepancy records produced by the Code Verifier.
 *
 * Requirements: 4.2
 */

// ---------------------------------------------------------------------------
// Code Context
// ---------------------------------------------------------------------------

/**
 * The code context provided to the Code Verifier for a verification run.
 */
export interface CodeContext {
  taskDescription: string;
  /** A unified diff or code snippet representing the changes to verify. */
  codeChanges: string;
  commitMessage?: string;
}

// ---------------------------------------------------------------------------
// Discrepancy
// ---------------------------------------------------------------------------

/**
 * A single discrepancy found between the code changes and an acceptance
 * criterion.
 */
export interface Discrepancy {
  /** The acceptance criterion that was not met. */
  criterion: string;
  /** What the criterion required. */
  expected: string;
  /** What the code actually does (or omits). */
  actual: string;
  severity: 'critical' | 'major' | 'minor';
}

// ---------------------------------------------------------------------------
// Verification Report
// ---------------------------------------------------------------------------

/**
 * The full verification report produced by the Code Verifier after comparing
 * code changes against a task's acceptance criteria.
 */
export interface VerificationReport {
  taskId: string;
  status: 'passed' | 'failed' | 'ambiguous';
  /** Overall match score from 0 (no match) to 100 (perfect match). */
  matchScore: number;
  analysis: {
    matchedCriteria: string[];
    unmatchedCriteria: string[];
    discrepancies: Discrepancy[];
    recommendations: string[];
  };
  generatedAt: string;
}

// ---------------------------------------------------------------------------
// Stored Verification Report
// ---------------------------------------------------------------------------

/**
 * A verification report as persisted in the database, including the code
 * context that was used.
 */
export interface StoredVerificationReport {
  id: string;
  taskId: string;
  report: VerificationReport;
  codeContext: CodeContext;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// QA Feedback
// ---------------------------------------------------------------------------

/**
 * Result of a single test case during QA.
 */
export interface TestCaseResult {
  testCaseId: string;
  status: 'passed' | 'failed' | 'skipped';
  actualResult?: string;
  notes?: string;
}

/**
 * QA feedback submitted for a task after testing.
 */
export interface QAFeedback {
  id: string;
  taskId: string;
  result: 'passed' | 'failed';
  /** Present when result is 'failed'. */
  failureType?: 'requirement_error' | 'implementation_error';
  details: string;
  testCaseResults: TestCaseResult[];
  reportedBy: string;
  reportedAt: string;
}
