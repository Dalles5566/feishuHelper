-- Feishu Helper Database Schema
-- Description: Complete schema for the Feishu Helper system
-- Run this file to set up a fresh database from scratch

-- Sequence for generating display IDs (F-000001, B-000001)
CREATE SEQUENCE IF NOT EXISTS task_display_id_seq START WITH 1 INCREMENT BY 1;

-- Meetings table
CREATE TABLE IF NOT EXISTS meetings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title VARCHAR(500),
  meeting_date TIMESTAMPTZ,
  feishu_doc_id VARCHAR(100) NOT NULL,
  raw_content TEXT,
  analysis JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Employees table (manually maintained team roster)
CREATE TABLE IF NOT EXISTS employees (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  open_id VARCHAR(100) NOT NULL UNIQUE,
  name VARCHAR(200) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'active',  -- active, on_leave, inactive
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_employees_open_id ON employees(open_id);
CREATE INDEX IF NOT EXISTS idx_employees_status ON employees(status);

-- Tasks table
CREATE TABLE IF NOT EXISTS tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  display_id VARCHAR(10) UNIQUE,
  task_type VARCHAR(10) NOT NULL DEFAULT 'feature',
  title VARCHAR(500) NOT NULL,
  description TEXT NOT NULL,
  acceptance_criteria JSONB NOT NULL DEFAULT '[]',
  dependencies JSONB NOT NULL DEFAULT '[]',
  priority VARCHAR(10) NOT NULL DEFAULT 'medium',
  state VARCHAR(30) NOT NULL DEFAULT 'Created',
  assignee_id VARCHAR(100),
  parent_task_id UUID REFERENCES tasks(id),
  source_action_item_id VARCHAR(100),
  feishu_task_id VARCHAR(100),
  retry_count INTEGER NOT NULL DEFAULT 0,
  failure_context TEXT,
  description_history JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Task-Meeting junction table (many-to-many)
CREATE TABLE IF NOT EXISTS task_meetings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  meeting_id UUID NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(task_id, meeting_id)
);

-- Workflow logs table
CREATE TABLE IF NOT EXISTS workflow_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES tasks(id),
  from_state VARCHAR(30) NOT NULL,
  to_state VARCHAR(30) NOT NULL,
  trigger VARCHAR(100) NOT NULL,
  actor VARCHAR(100) NOT NULL,
  reason TEXT,
  metadata JSONB,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Task assignments table
CREATE TABLE IF NOT EXISTS task_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES tasks(id),
  assignee_id VARCHAR(100) NOT NULL,
  assignee_name VARCHAR(200) NOT NULL,
  assigned_by VARCHAR(100) NOT NULL,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status VARCHAR(20) NOT NULL DEFAULT 'active'
);

-- Verification reports table
CREATE TABLE IF NOT EXISTS verification_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES tasks(id),
  report JSONB NOT NULL,
  code_context JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- QA feedbacks table
CREATE TABLE IF NOT EXISTS qa_feedbacks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES tasks(id),
  result VARCHAR(10) NOT NULL,
  failure_type VARCHAR(30),
  details TEXT,
  test_case_results JSONB NOT NULL DEFAULT '[]',
  reported_by VARCHAR(100) NOT NULL,
  reported_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Documents table
CREATE TABLE IF NOT EXISTS documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title VARCHAR(500) NOT NULL,
  doc_type VARCHAR(30) NOT NULL,
  content TEXT,
  sections JSONB,
  version VARCHAR(20) NOT NULL DEFAULT '1.0.0',
  related_task_id UUID REFERENCES tasks(id),
  feishu_doc_id VARCHAR(100),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_tasks_display_id ON tasks(display_id);
CREATE INDEX IF NOT EXISTS idx_tasks_state ON tasks(state);
CREATE INDEX IF NOT EXISTS idx_tasks_assignee_id ON tasks(assignee_id);
CREATE INDEX IF NOT EXISTS idx_tasks_parent_task_id ON tasks(parent_task_id);
CREATE INDEX IF NOT EXISTS idx_task_meetings_task_id ON task_meetings(task_id);
CREATE INDEX IF NOT EXISTS idx_task_meetings_meeting_id ON task_meetings(meeting_id);
CREATE INDEX IF NOT EXISTS idx_workflow_logs_task_id ON workflow_logs(task_id);
CREATE INDEX IF NOT EXISTS idx_workflow_logs_timestamp ON workflow_logs(timestamp);
CREATE INDEX IF NOT EXISTS idx_task_assignments_task_id ON task_assignments(task_id);
CREATE INDEX IF NOT EXISTS idx_task_assignments_assignee_id ON task_assignments(assignee_id);
CREATE INDEX IF NOT EXISTS idx_verification_reports_task_id ON verification_reports(task_id);
CREATE INDEX IF NOT EXISTS idx_qa_feedbacks_task_id ON qa_feedbacks(task_id);
CREATE INDEX IF NOT EXISTS idx_documents_related_task_id ON documents(related_task_id);
CREATE INDEX IF NOT EXISTS idx_documents_doc_type ON documents(doc_type);
