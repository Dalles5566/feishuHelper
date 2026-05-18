/**
 * Meeting-related TypeScript interfaces and types.
 *
 * Defines the data structures for meeting records, AI analysis results,
 * action items, and summaries produced by the Meeting Analyzer.
 *
 * Requirements: 1.2, 1.3
 */

// ---------------------------------------------------------------------------
// Meeting Summary
// ---------------------------------------------------------------------------

/**
 * High-level summary of a meeting produced by the Meeting Analyzer.
 */
export interface MeetingSummary {
  title: string;
  date: string;
  participants: string[];
  keyPoints: string[];
  overallSummary: string;
}

// ---------------------------------------------------------------------------
// Action Item
// ---------------------------------------------------------------------------

/**
 * A concrete action item extracted from meeting minutes.
 * Each action item typically maps to one Task in the system.
 */
export interface ActionItem {
  id: string;
  description: string;
  /** Additional context from the meeting discussion. */
  context: string;
  priority: 'high' | 'medium' | 'low';
  /** Feishu user ID suggested by the AI as the best assignee. */
  suggestedAssignee?: string;
  /** IDs of other action items this one depends on. */
  dependencies: string[];
}

// ---------------------------------------------------------------------------
// Decision & Discussion Point
// ---------------------------------------------------------------------------

/**
 * A decision made during the meeting.
 */
export interface Decision {
  id: string;
  description: string;
  rationale?: string;
  madeBy?: string;
}

/**
 * A discussion point raised during the meeting (may not result in a decision).
 */
export interface DiscussionPoint {
  id: string;
  topic: string;
  summary: string;
  outcome?: string;
}

// ---------------------------------------------------------------------------
// Meeting Analysis
// ---------------------------------------------------------------------------

/**
 * Full structured analysis of a meeting produced by the Meeting Analyzer.
 */
export interface MeetingAnalysis {
  summary: MeetingSummary;
  actionItems: ActionItem[];
  decisions: Decision[];
  discussionPoints: DiscussionPoint[];
}

// ---------------------------------------------------------------------------
// Meeting Entity
// ---------------------------------------------------------------------------

/**
 * Persisted meeting record, including the raw content and AI analysis.
 */
export interface Meeting {
  id: string;
  title: string;
  date: string;
  /** Feishu document ID for the meeting minutes. */
  feishuDocId: string;
  rawContent: string;
  analysis: MeetingAnalysis;
  /** IDs of tasks created from this meeting's action items. */
  createdTasks: string[];
  createdAt: string;
}
