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
- 理解了 AgentCore（AI Agent 核心）的设计：
  - 整个系统的"大脑"，把 LLM（GPT-4/Claude）和飞书 MCP 工具连在一起
  - 核心方法 `processInput`：收消息 → 问 LLM → LLM 可能调工具 → 工具结果反馈给 LLM → 最终回复用户
  - **tool-calling loop**：LLM 可能需要多次调工具才能完成任务（如创建 3 个 ticket），循环直到 LLM 给出纯文字回复
  - **会话历史**：LLM 本身没有记忆，每次调用都要把之前所有对话重新发一遍。超过 50 条就裁剪最早的
  - **bindTools**：告诉 LLM "你可以用这些工具"，本质是在 API 请求里多加一个字段描述可用工具
  - **AgentCore 不直接调 workflow 或数据库**：它只负责"对话 + 调 MCP 工具"，workflow 和数据库的串联在 Task 14 集成时完成
  - LLM 自己决定 ticket 内容——从会议纪要里提取信息，自己填好参数调 task_create

### 今日完成内容（续）

- 完成 Task 6.1：实现 AI Agent Core（247 个测试全部通过）
  - 创建 `src/agent/agentCore.ts`：基于 LangChain.js 的 tool-calling Agent
  - 支持 OpenAI 和 Anthropic 两种 LLM Provider
  - 注册飞书 MCP 工具为 LangChain DynamicStructuredTool
  - 实现会话上下文管理（getContext、clearContext、trimContext）
  - 创建 `src/agent/agentCore.test.ts`：25 个单元测试
- 理解了 MeetingAnalyzer（会议纪要分析器）的设计：
  - 三个方法：`analyze`（完整分析）、`extractActionItems`（只提取行动项）、`generateSummary`（只生成摘要）——同一个能力的不同粒度
  - 用 Zod schema 定义 LLM 返回格式，`.describe()` 里的文字是给 LLM 看的提示
  - 超长内容处理：切成重叠的片段 → 每段分别分析 → 最后让 LLM 合并去重，最终结果跟一次性发完整内容一样
  - `JSON.stringify(chunkResults, null, 2)` 把对象转成格式化 JSON 字符串发给 LLM
  - actionItems 和 decisions 不靠数组下标对应，靠 context 字段和 ID 语义关联

### 今日完成内容（续2）

- 完成 Task 6.2：实现 Meeting Analyzer（265 个测试全部通过）
  - 创建 `src/services/meetingAnalyzer.ts`：LangChain.js 结构化输出解析
  - 实现 analyze、extractActionItems、generateSummary 三个方法
  - 实现超长内容分段处理和合并逻辑
  - 创建 `src/services/meetingAnalyzer.test.ts`：18 个单元测试
- 完成 Task 7.1：实现 Task Manager（291 个测试全部通过）
  - 创建 `src/services/taskManager.ts`：任务 CRUD 操作
  - createTask：飞书 MCP 创建 + 本地数据库持久化 + 重试 3 次
  - splitTask：拆分子任务 + scope 重叠检测
  - updateTaskDescription：更新描述 + 保留完整历史
  - updateTaskState：调状态机执行状态转换
  - 创建 `src/services/taskManager.test.ts`：26 个单元测试
- 在 steering rules 中记录了任务描述格式要求（总概括 + 要点 + 变更历史，最新日期在最上面）

### 今日学习笔记（续2）

- 理解了 taskManager、workflowEngine、stateMachine 三者的分层关系：
  - **stateMachine**（最底层）：纯规则——状态 A 能不能转到状态 B，不知道业务
  - **workflowEngine**（中间层）：把业务事件翻译成状态转换，调 stateMachine 执行
  - **taskManager**（最上层）：管任务本身的 CRUD，需要改状态时调 stateMachine
- 理解了 createTask 的流程：验证参数 → 调飞书 MCP 创建（带重试）→ 存本地数据库 → 返回
- 飞书 MCP 返回格式不确定，代码做了多种兼容（JSON/纯文本），等联调时确认

---

## 2026-05-09（周六）

### 今日完成内容

- 完成 Task 7.3：实现任务分配管理（310 个测试全部通过）
  - 创建 `src/services/taskAssignment.ts`：分配关系 CRUD
  - assignTask：创建分配记录，重新分配时旧记录标记为 reassigned
  - confirmAssignment：开发者确认接受任务
  - completeAssignment：任务完成时标记分配为 completed
  - getActiveAssignments：查看当前所有活跃分配关系
  - 创建 `src/services/taskAssignment.test.ts`：19 个单元测试

### 今日学习笔记

- 理解了 `task_assignments` 表和 `tasks` 表的区别：
  - `tasks` 表：任务本身的状态（11 种：Created → ... → Completed）
  - `task_assignments` 表：分配关系（3 种状态：active、reassigned、completed）
  - 创建任务时只写 tasks 表，分配时才写 task_assignments 表
  - 不是每次状态变更都改两张表，只有跟分配相关的操作才同时动两边
- 理解了 confirmAssignment 的意义：开发者确认接受任务后才开始监控进度，对于晨会场景可以跳过

### 今日完成内容（续）

- 完成 Task 8 Checkpoint：310 个测试全部通过
- 完成 Task 9.1：实现 Code Verifier（336 个测试全部通过）
  - 创建 `src/services/codeVerifier.ts`：LLM 对比代码与任务描述
  - **设计决策：无论 AI 验证结果如何，都推进到 QA**，AI 的 score 和 discrepancies 作为参考
  - Token 超限时自动生成 ambiguous 报告，不 block 流程
  - 验证报告持久化到 verification_reports 表
  - 创建 `src/services/codeVerifier.test.ts`：26 个单元测试
  - 更新 design.md 和 tasks.md 反映新的设计决策

### 今日学习笔记（续）

- 理解了 CodeVerifier 的工作方式：把 git diff + 任务验收标准发给 LLM，LLM 判断代码是否满足标准
- 理解了 `withStructuredOutput`：LangChain 的方法，传入 Zod schema 让 LLM 按固定格式返回 JSON
- 理解了 `skipWorkflowAdvance`：测试用的开关，跳过工作流推进只测验证逻辑本身
- 设计决策：AI 验证不 block 流程，永远进 QA，让人做最终判断。以后可能完全跳过 codeVerifier 这步

---

## 2026-05-13（周二）

### 今日完成内容

- 在 steering rules 中添加了开发工作流原则（Superpowers 启发）
- 完成 Task 10.1：实现测试文档生成（360 个测试全部通过）
  - 创建 `src/services/docGenerator.ts`：基于 LLM 生成测试用例
  - 生成正向、负向、边界条件测试用例
  - 每个用例包含前置条件、步骤、预期结果
  - 任务描述不足时标记缺失信息
  - 创建 `src/services/docGenerator.test.ts`：24 个单元测试
- 跳过 Task 10.3（MD 文档更新）和 10.5（使用手册编译）——不需要

### 今日学习笔记

- docGenerator 跟 meetingAnalyzer、codeVerifier 是同一个套路：定义 Zod schema → 拼 prompt → 发给 LLM → 拿结构化结果
- `generateTestDocument` 不是给 .test.ts 用的，是给 QA 工程师看的测试用例文档
- `getLlm()` 在三个 service 里都是一样的代码（后续可以抽成共享工具函数）
