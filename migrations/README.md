# Database Migrations

## Setup

Run `schema.sql` to create a fresh database:

```bash
docker exec -i feishu-postgres psql -U postgres -d feishu_helper -f /dev/stdin < migrations/schema.sql
```

## Schema Overview

- `meetings` — Meeting records with raw content and analysis
- `tasks` — Development tasks with display_id (F-000001, B-000001), state machine, and history
- `task_meetings` — Many-to-many junction between tasks and meetings
- `workflow_logs` — State transition audit log
- `task_assignments` — Task-developer assignment relationships
- `verification_reports` — AI code verification results
- `qa_feedbacks` — QA test results
- `documents` — Generated test docs and manuals

## Display ID

Tasks get a human-readable `display_id` auto-generated via a PostgreSQL sequence:
- `F-XXXXXX` for features
- `B-XXXXXX` for bug fixes

The sequence (`task_display_id_seq`) guarantees uniqueness without collision.
