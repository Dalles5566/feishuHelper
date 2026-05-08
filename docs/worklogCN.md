# 每日工作日志

> **说明：** 本项目全程由 AI 辅助完成（Kiro）。所有代码、文档和架构决策均由 AI 生成，人工负责指导和审批。

---

## 2026-05-05（周二）

### 今日完成内容

- 初始化 feishuHelper 项目工作区
- 按照需求优先的工作流创建了项目 spec：
  - 编写了 `requirements.md`，覆盖 10 个核心需求（会议分析、任务管理、任务分配、代码验证、测试文档生成、QA 反馈路由、MD 文档更新、使用手册编译、工作流状态管理、飞书 API 集成）
  - 根据用户反馈，在工作流状态管理需求中补充了"会议更新触发任务回退"的循环机制
- 创建了 `design.md` 完整技术设计文档：
  - 架构：AI Agent + 飞书 MCP 后端服务 + 飞书机器人交互入口
  - 技术栈：Node.js/TypeScript、LangChain.js、@larksuiteoapi/lark-mcp、PostgreSQL、Redis（BullMQ）、Fastify
  - 定义了 8 个核心组件及 TypeScript 接口
  - 设计了包含所有回退路径的工作流状态机
  - 定义了 16 个正确性属性用于属性基测试
  - 记录了错误处理、重试策略和测试策略
- 配置 GitHub 仓库：
  - 初始化 git，创建 `.gitignore`
  - 安装 GitHub CLI（`gh`）并完成认证
  - 创建公开仓库：https://github.com/Dalles5566/feishuHelper
  - 将初始提交推送到 `main` 分支
- 创建中英文双语版本的设计文档和工作日志
- 配置了 `.kiro/steering/rules.md` 开发规范（代码语言、注释语言、commit 格式等）
- 创建了 `docs/skills.md` 用于记录学习到的技能
- 学习了 Kiro Hook 的概念：
  - Hook 是一个"自动触发器"——当某个事件发生时，自动执行某个动作
  - 例如：文件被编辑时 → 自动提醒同步双语文档
  - 创建了 `sync-design-docs` hook，当 design.md 更新时自动同步 designCN/EN
- 完成 Task 1.1：项目初始化与 TypeScript 配置
  - 创建 package.json，安装所有依赖（fastify、langchain、lark-mcp、bullmq、pg、ioredis、vitest、fast-check、eslint、prettier）
  - 配置 tsconfig.json（严格模式、ES2022、NodeNext 模块）
  - 配置 ESLint + Prettier 代码规范和格式化
  - 配置 vitest 测试框架
  - 创建 src/ 目录结构：gateway、agent、workflow、services、models、utils、config
- 生成了 tasks.md 实现计划，包含 15 个顶层任务覆盖完整开发周期
- 完成 Task 1.2：数据库配置与 Schema 迁移
  - 创建 `migrations/001_initial_schema.sql`，包含 7 张表（meetings、tasks、workflow_logs、task_assignments、verification_reports、qa_feedbacks、documents）和索引
  - 创建 `src/config/database.ts`，实现连接池管理（getPool、closePool、runMigrations）
  - 创建 `src/utils/db.ts`，封装数据库操作工具函数（query、queryOne、insert、update、remove、withTransaction）
  - 18 个单元测试全部通过
- 完成 Task 1.3：环境变量与应用配置
  - 创建 `src/config/index.ts`，定义所有配置项（飞书、LLM、数据库、Redis、应用），启动时验证必填项
  - 创建 `.env.example` 模板文件，覆盖所有支持的环境变量
  - 40 个单元测试全部通过
  - 配置本地开发环境：使用 Docker 运行 PostgreSQL（端口 5432）和 Redis（端口 6379）

---

## 2026-05-07（周四）

### 今日完成内容

- 完成 Task 2：核心类型定义与错误处理框架
  - 创建 `src/models/task.ts`、`meeting.ts`、`workflow.ts`、`verification.ts`、`document.ts`、`index.ts`，定义所有核心 TypeScript 类型
  - 创建 `src/utils/errors.ts`：AppError 类，5 种错误分类，静态工厂方法，常用错误码常量
  - 创建 `src/utils/retry.ts`：指数退避重试策略，withRetry() 函数，可注入 sleep（方便测试）
  - 98 个单元测试全部通过
- 完成 Task 3.1：实现任务状态机
  - 创建 `src/workflow/stateMachine.ts`：16 条合法状态转换规则、validateTransition()、transition()（含乐观锁和日志记录）、getValidNextStates()
  - 创建 `src/workflow/stateMachine.test.ts`：41 个单元测试覆盖正向转换、回退转换、非法转换、重试计数器、并发冲突检测
  - 139 个测试全部通过
- 完成 Task 3.5：实现工作流引擎
  - 创建 `src/workflow/workflowEngine.ts`：startWorkflow()、advanceWorkflow()、revertWorkflow()、handleMeetingUpdateForAllTasks()、getWorkflowStatus()
  - 事件到状态的映射逻辑（assignment→Assigned、dev_complete→VerificationPending 等）
  - 会议更新批量回退逻辑
  - 创建 `src/workflow/workflowEngine.test.ts`：26 个单元测试
  - 165 个测试全部通过

---

## 2026-05-08（周五）

### 今日学习笔记

- 理解了 `errors.ts` + `retry.ts` 的设计思路：
  - `errors.ts`：统一错误分类系统。把所有错误分成 5 类（feishu_api、llm_service、state_transition、validation、business_logic），每类有不同的处理策略（能不能重试、重试几次）
  - `retry.ts`：指数退避重试工具。核心是 `withRetry(fn)` 函数——把 try/catch 和重试逻辑封装在一起，把要执行的函数传进去，如果函数抛错了，`withRetry` 会 catch 住，判断错误类别能不能重试，能的话等一段时间（每次翻倍）再执行一次，不能的话直接把错误抛出去
  - 使用方式：需要主动 call，不是自动拦截。在调外部 API（飞书、LLM）的地方用 `withRetry(() => apiCall())` 包裹，内部逻辑不需要重试的就直接抛 AppError

### 今日完成内容

- 修复 tasks.md 中的任务状态标记（Task 1、3 恢复为进行中，3.3 恢复为可选，3.5 标记为已完成）
- 完成 Task 4 Checkpoint：状态机和工作流引擎 67 个测试全部通过
- 完成 Task 5：Webhook Gateway 与飞书集成（222 个测试全部通过）
  - 5.1 Webhook Gateway：签名验证、URL Challenge、事件分发
  - 5.2 飞书认证与 Token 管理：App 凭证认证、Redis 缓存、过期前主动刷新
  - 5.3 飞书 MCP 集成：LarkMcpTool 封装、统一错误处理、指数退避限流

### 今日学习笔记（续）

- 理解了 Webhook Gateway 中 EventDispatcher 的设计：
  - **EventDispatcher = 主管**：知道"这件事该谁负责"，负责分配任务，不关心业务逻辑
  - **Handler = 员工**：真正做事的函数，专门处理某种事件类型
  - **register = 登记上岗**：员工告诉主管"我在这里，我专门处理这类事件"
  - **FeishuEvent = 顾客**：只需要告诉系统事件是什么类型，主管自动找对应员工处理
  - **EventHandler 是函数类型约定**：凡是想注册的函数，必须接收 FeishuEvent 参数并返回 Promise<void>
- 理解了 Webhook 签名验证的意义：服务器暴露在公网，任何人都可以往 URL 发请求。签名验证通过 encryptKey（只有你和飞书知道）确保请求真的来自飞书，防止伪造
- 理解了 FeishuAuthService（Token 管理）的设计：
  - 核心逻辑：用 appId + appSecret 向飞书换 token → 存 Redis → 下次直接从 Redis 取
  - **提前 5 分钟刷新**：不等 token 真的过期才换，留缓冲时间避免"取到 token 但调 API 时刚好过期"的窗口期
  - **并发去重（refreshPromise）**：100 个请求同时发现没 token，只让第一个去飞书换，其余 99 个等同一个 Promise，避免打爆飞书 API
  - 这些边缘情况是生产环境经验积累出来的，不是一开始就能想到的
- 理解了 FeishuMcpService（飞书 MCP 集成）的设计：
  - MCP 是飞书官方工具包，把飞书 API 封装成一个个"工具"（如 task_create、im_send_message），不用自己拼 HTTP 请求
  - `FeishuMcpService` 是 MCP 的包装层，加了三个东西：自动带 token、统一错误分类、自动重试
  - 使用方式：`mcp.callTool('task_create', { title: '...' })`，token/重试/错误处理全在内部搞定
  - 现在只是把管道接好了（准备好了可以随时调用），等后面 AI Agent 和 Task Manager 实现后才会真正调用
  - constructor 里的 `private readonly` 类似 Java 的 `private final` + `@Autowired`：依赖注入，测试时传 mock，生产时用真实实例
