-- Migration 002: Change task-meeting relationship from one-to-many to many-to-many
-- A task can be discussed in multiple meetings, and a meeting can produce multiple tasks.

-- Step 1: Create the junction table
CREATE TABLE task_meetings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  meeting_id UUID NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(task_id, meeting_id)
);

CREATE INDEX idx_task_meetings_task_id ON task_meetings(task_id);
CREATE INDEX idx_task_meetings_meeting_id ON task_meetings(meeting_id);

-- Step 2: Remove meeting_id from tasks table
ALTER TABLE tasks DROP COLUMN IF EXISTS meeting_id;
