# Daily Work Log

> **Note:** This project is entirely built with AI assistance (Kiro). All code, documentation, and architecture decisions are AI-generated with human guidance and approval.

---

## 2026-05-05 (Tuesday)

### What was done today

- Initialized the feishuHelper project workspace
- Created the project spec following a requirements-first workflow:
  - Drafted `requirements.md` covering 10 core requirements (meeting analysis, task management, assignment, code verification, test doc generation, QA feedback routing, MD doc updates, user manual compilation, workflow state management, Feishu API integration)
  - Added the meeting-update-triggers-task-revert loop to the workflow state management requirement based on user feedback
- Created `design.md` with full technical design:
  - Architecture: AI Agent + Feishu MCP backend service + Feishu Bot as interaction entry
  - Tech stack: Node.js/TypeScript, LangChain.js, @larksuiteoapi/lark-mcp, PostgreSQL, Redis (BullMQ), Fastify
  - Defined 8 core components with TypeScript interfaces
  - Designed workflow state machine with all revert paths
  - Defined 16 correctness properties for property-based testing
  - Documented error handling, retry strategies, and testing strategy
- Set up GitHub repository:
  - Initialized git, created `.gitignore`
  - Installed GitHub CLI (`gh`) and authenticated
  - Created public repo: https://github.com/Dalles5566/feishuHelper
  - Pushed initial commit to `main` branch
- Created bilingual design docs and work logs in `docs/` folder
- Configured `.kiro/steering/rules.md` with development conventions (language, comments, commit format, etc.)
- Created `docs/skills.md` for tracking skills learned
- Learned about Kiro Hooks:
  - A hook is an "automatic trigger" — when an event occurs, it automatically performs an action
  - Example: when a file is edited → automatically remind to sync bilingual docs
  - Created `sync-design-docs` hook to auto-sync designCN/EN when design.md is updated
- Completed Task 1.1: Project initialization and TypeScript configuration
  - Created package.json with all dependencies (fastify, langchain, lark-mcp, bullmq, pg, ioredis, vitest, fast-check, eslint, prettier)
  - Configured tsconfig.json with strict mode, ES2022 target, NodeNext modules
  - Set up ESLint + Prettier for code quality and formatting
  - Configured vitest for testing
  - Created src/ directory structure: gateway, agent, workflow, services, models, utils, config
- Generated tasks.md implementation plan with 15 top-level tasks covering the full development lifecycle
- Completed Task 1.2: Database configuration and schema migration
  - Created `migrations/001_initial_schema.sql` with all 7 tables (meetings, tasks, workflow_logs, task_assignments, verification_reports, qa_feedbacks, documents) and indexes
  - Created `src/config/database.ts` with connection pool management (getPool, closePool, runMigrations)
  - Created `src/utils/db.ts` with query utility functions (query, queryOne, insert, update, remove, withTransaction)
  - All 18 unit tests passing
- Completed Task 1.3: Environment variables and application configuration
  - Created `src/config/index.ts` with all config groups (feishu, llm, database, redis, app) and startup validation for required variables
  - Created `.env.example` template covering all supported environment variables
  - All 40 unit tests passing
  - Set up local dev environment: PostgreSQL (port 5432) and Redis (port 6379) running via Docker

---

## 2026-05-07 (Thursday)

### What was done today

- Completed Task 2: Core type definitions and error handling framework
  - Created `src/models/task.ts`, `meeting.ts`, `workflow.ts`, `verification.ts`, `document.ts`, `index.ts` with all core TypeScript types
  - Created `src/utils/errors.ts`: AppError class, 5 error categories, static factory methods, well-known error code constants
  - Created `src/utils/retry.ts`: exponential backoff retry strategy, withRetry() function with injectable sleep for testing
  - All 98 unit tests passing
- Completed Task 3.1: Implement task state machine
  - Created `src/workflow/stateMachine.ts`: 16 valid transition rules, validateTransition(), transition() with optimistic locking and audit logging, getValidNextStates()
  - Created `src/workflow/stateMachine.test.ts`: 41 unit tests covering forward transitions, revert transitions, invalid transitions, retry counter, concurrent modification detection
  - All 139 tests passing
- Completed Task 3.5: Implement workflow engine
  - Created `src/workflow/workflowEngine.ts`: startWorkflow(), advanceWorkflow(), revertWorkflow(), handleMeetingUpdateForAllTasks(), getWorkflowStatus()
  - Event-to-state mapping logic (assignment→Assigned, dev_complete→VerificationPending, etc.)
  - Meeting update bulk revert logic
  - Created `src/workflow/workflowEngine.test.ts`: 26 unit tests
  - All 165 tests passing

---

## 2026-05-08 (Friday)

### Learning Notes

- Understood the design of `errors.ts` + `retry.ts`:
  - `errors.ts`: Unified error classification system. All errors are categorized into 5 types (feishu_api, llm_service, state_transition, validation, business_logic), each with different handling strategies (retryable or not, how many retries)
  - `retry.ts`: Exponential backoff retry utility. The core is `withRetry(fn)` — it wraps try/catch and retry logic together. You pass in the function to execute; if it throws, `withRetry` catches it, checks the error category to decide if it's retryable, waits (doubling each time) and retries, or re-throws immediately if not retryable
  - Usage: Must be called explicitly, not automatic interception. Wrap external API calls (Feishu, LLM) with `withRetry(() => apiCall())`; internal logic that shouldn't retry just throws AppError directly

### What was done today

- Fixed task status markers in tasks.md (Task 1, 3 restored to in-progress, 3.3 restored to optional, 3.5 marked as completed)
- Completed Task 4 Checkpoint: all 67 state machine and workflow engine tests passing
- Completed Task 5: Webhook Gateway and Feishu integration (all 222 tests passing)
  - 5.1 Webhook Gateway: signature verification, URL Challenge, event dispatching
  - 5.2 Feishu Auth & Token Management: App credentials auth, Redis caching, proactive refresh before expiry
  - 5.3 Feishu MCP Integration: LarkMcpTool wrapper, unified error handling, exponential backoff rate limiting

### Learning Notes (continued)

- Understood the EventDispatcher design in Webhook Gateway:
  - **EventDispatcher = manager**: knows "who handles what", dispatches tasks, doesn't care about business logic
  - **Handler = employee**: the function that actually does the work, specialized for a specific event type
  - **register = clocking in**: the employee tells the manager "I'm here, I handle this type of event"
  - **FeishuEvent = customer**: just needs to tell the system what type of event it is; the manager finds the right employee automatically
  - **EventHandler is a function type contract**: any function that wants to register must accept a FeishuEvent parameter and return Promise<void>
- Understood why Webhook signature verification matters: the server is exposed on the public internet, anyone can POST to the URL. Signature verification uses encryptKey (known only to you and Feishu) to prove the request genuinely came from Feishu, preventing forgery
- Understood FeishuAuthService (Token Management) design:
  - Core logic: exchange appId + appSecret for a token from Feishu → store in Redis → next time read directly from Redis
  - **Proactive refresh 5 minutes early**: don't wait until the token actually expires; leave buffer time to avoid the "fetched token but it expired by the time the API call reaches Feishu" window
  - **Concurrent deduplication (refreshPromise)**: if 100 requests simultaneously discover no token, only the first one calls Feishu; the other 99 await the same Promise, preventing API flooding
  - These edge cases come from production experience, not something you'd think of on the first try
- Understood FeishuMcpService (Feishu MCP Integration) design:
  - MCP is Feishu's official toolkit that wraps Feishu APIs into callable "tools" (e.g., task_create, im_send_message) — no need to manually construct HTTP requests
  - `FeishuMcpService` is a wrapper around MCP that adds three things: automatic token injection, unified error classification, and automatic retry
  - Usage: `mcp.callTool('task_create', { title: '...' })` — token/retry/error handling all handled internally
  - Right now it's just "pipes connected" (ready to be called); actual calls happen later when AI Agent and Task Manager are implemented
  - `private readonly` in the constructor is like Java's `private final` + `@Autowired`: dependency injection — pass mocks in tests, real instances in production
- Understood AgentCore (AI Agent Core) design:
  - The system's "brain" — connects LLM (GPT-4/Claude) with Feishu MCP tools
  - Core method `processInput`: receive message → ask LLM → LLM may call tools → feed tool results back to LLM → final reply to user
  - **tool-calling loop**: LLM may need multiple tool calls to complete a task (e.g., creating 3 tickets), loops until LLM gives a plain text response
  - **Conversation history**: LLM has no memory; every call must resend all previous messages. Trims oldest messages when exceeding 50
  - **bindTools**: tells LLM "you can use these tools" — essentially adds a field to the API request describing available tools
  - **AgentCore doesn't directly call workflow or database**: it only handles "conversation + MCP tool calls"; workflow/DB integration happens in Task 14
  - LLM decides ticket content itself — extracts info from meeting minutes and fills in the parameters for task_create

### What was done today (continued)

- Completed Task 6.1: Implement AI Agent Core (all 247 tests passing)
  - Created `src/agent/agentCore.ts`: LangChain.js-based tool-calling Agent
  - Supports both OpenAI and Anthropic LLM providers
  - Registers Feishu MCP tools as LangChain DynamicStructuredTool instances
  - Implements session context management (getContext, clearContext, trimContext)
  - Created `src/agent/agentCore.test.ts`: 25 unit tests
