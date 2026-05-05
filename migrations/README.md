# Database Migrations

This directory contains SQL migration scripts for the Feishu Helper database.

## Naming Convention

Migration files follow the pattern: `NNN_description.sql`

- `NNN` — Zero-padded sequential number (e.g., 001, 002)
- `description` — Brief snake_case description of the migration

## Running Migrations

Migrations are executed by the migration runner in `src/config/database.ts`.

```typescript
import { runMigrations } from './src/config/database.js';

await runMigrations();
```

The runner tracks applied migrations in a `schema_migrations` table and only applies new ones.

## Current Migrations

| File | Description |
|------|-------------|
| 001_initial_schema.sql | Creates all initial tables: meetings, tasks, workflow_logs, task_assignments, verification_reports, qa_feedbacks, documents |
