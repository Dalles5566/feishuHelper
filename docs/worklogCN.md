# 每日工作日志

> **说明：** 本项目全程由 AI 辅助完成（Kiro）。所有代码、文档和架构决策均由 AI 生成，人工负责指导和审批。

---

## 2026-05-05（周一）

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

## 2026-05-07（周三）

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

## 2026-05-08（周四）

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

## 2026-05-09（周五）

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

## 2026-05-13（周三）

### 今日完成内容

- 在 steering rules 中添加了开发工作流原则（Superpowers 启发）
- 完成 Task 10.1：实现测试文档生成（360 个测试全部通过）
  - 创建 `src/services/docGenerator.ts`：基于 LLM 生成测试用例
  - 生成正向、负向、边界条件测试用例
  - 每个用例包含前置条件、步骤、预期结果
  - 任务描述不足时标记缺失信息
  - 创建 `src/services/docGenerator.test.ts`：24 个单元测试
- 跳过 Task 10.3（MD 文档更新）和 10.5（使用手册编译）——不需要

### 今日完成内容（续）

- 完成 Task 11.1：实现 QA 反馈处理
  - 创建 `src/services/qaFeedback.ts`：QA 结果提交和查询
  - QA 通过 → 推进到 QAPassed
  - QA 失败（需求错误/unknown）→ 回退到 Created
  - QA 失败（实现错误）→ 回退到 InDevelopment
  - failureType 不提供时默认为 unknown，回退到 Created
  - 创建 `src/services/qaFeedback.test.ts`：10 个单元测试

### 今日学习笔记

- docGenerator 跟 meetingAnalyzer、codeVerifier 是同一个套路：定义 Zod schema → 拼 prompt → 发给 LLM → 拿结构化结果
- `generateTestDocument` 不是给 .test.ts 用的，是给 QA 工程师看的测试用例文档
- `getLlm()` 在三个 service 里都是一样的代码（后续可以抽成共享工具函数）
- 理解了消息队列（BullMQ）的核心概念：
  - **为什么需要队列**：webhook 收到请求后要快速回复 200，耗时操作（调 LLM、调飞书 API）放队列里后台处理
  - **Redis 的角色**：不会丢东西的排队架。服务器重启消息还在，Worker 忙的时候消息排队等
  - **BullMQ**：在 Redis 上加了队列管理逻辑（排序、重试、失败处理、Worker 调度）
  - **Worker**：不断从 Redis 取任务处理的后台代码，像厨师不停从窗口取订单
  - **5 个专用队列**：不是给 webhook 直接用的，是给 AgentCore 内部分发子任务用的
  - **入口队列**：webhook 丢消息进来，Worker 取出调 AgentCore
  - **fire and forget**：丢进队列就不管了，不需要等结果回传
  - **快操作不需要队列**：QA Feedback、Task Assignment 几毫秒搞定，直接同步做

---

## 2026-05-14（周四）

### 今日完成内容

- 完成 Task 13.2：实现通知服务（436 个测试全部通过）
  - 创建 `src/services/notification.ts`：通过飞书 MCP 发消息通知
  - 支持 4 种通知类型：任务分配、状态变更、需求变更、验证结果
  - 发送失败时自动丢进 notification 队列重试
  - 创建 `src/services/notification.test.ts`：22 个单元测试
- 完成 Task 14.1：实现应用启动入口（441 个测试全部通过）
  - 创建 `src/app.ts`：Fastify 应用配置，注册健康检查 `/health` + webhook 路由
  - 更新 `src/index.ts`：程序入口，初始化数据库 → 队列 → 启动服务器 → 优雅关闭
  - 创建 `src/app.test.ts`：5 个单元测试

### 今日学习笔记

- Fastify 就是 HTTP 服务器框架（相当于 Java 的 Spring Boot），让代码能监听 HTTP 请求
- `app.get('/health', handler)` 就是 Fastify 版的 `@GetMapping("/health")`
- `index.ts` 是程序入口（相当于 Java 的 main），负责启动所有服务（数据库、队列、HTTP 服务器）
- `app.ts` 和 `index.ts` 分开是为了测试方便——测试时只用 `buildApp()` 不启动真正的服务器
- notification 服务的 `formatNotificationMessage` 是 `sendNotification` 内部调用的，外部只需要调 `sendNotification` 传类型和参数

### 今日完成内容（续）

- 完成 Task 14.2：集成所有模块完成完整工作流（451 个测试全部通过）
  - 创建 `src/integration/messageHandler.ts`：连接 EventDispatcher → AgentCore → NotificationService
  - 注册 `im.message.receive_v1` handler：解析消息 → 调 AgentCore → 发回复通知
  - 注册 `card.action.trigger` handler：处理卡片按钮点击
  - 更新 `src/app.ts`：初始化 AgentCore + NotificationService，调用 registerMessageHandler 串联
  - 创建 `src/integration/messageHandler.test.ts`：10 个单元测试
- 配置运行环境：
  - 启动 PostgreSQL Docker 容器
  - 创建 feishu_helper 数据库并执行迁移脚本（7 张表 + 索引）
  - 确认 Redis 正在运行（端口 6379）

### 今日学习笔记（续）

- 理解了 .env 配置文件各项含义：
  - 飞书配置：APP_ID/SECRET（换 token 用）、VERIFICATION_TOKEN（验签用）、ENCRYPT_KEY（签名用）
  - LLM 配置：PROVIDER（openai/anthropic）、API_KEY（花钱调 AI）、MODEL（用哪个模型）
  - 数据库配置：HOST/PORT/NAME/USER/PASSWORD（连接 PostgreSQL）
  - Redis 配置：HOST/PORT/PASSWORD（BullMQ 队列 + token 缓存）
  - 应用配置：PORT（监听端口）、NODE_ENV（环境）、LOG_LEVEL（日志级别）
- 理解了 14.2 集成的核心：messageHandler 把 dispatcher、agentCore、notificationService 三者串联起来
- MVP 选择直接调用 AgentCore（不走队列），以后需要时改一行代码就能切换到队列模式


---

## 2026-05-15（周五）

### 今日完成内容

- 修复 `npm run dev` 无法读取 `.env` 文件的问题
  - 原因：`tsx` 不自动加载 `.env`，需要显式传入
  - 修复：在 `package.json` 的 `dev` 和 `start` 脚本中加入 `--env-file=.env` 参数
- 修复 `@larksuiteoapi/lark-mcp` 启动时打印 CLI 帮助信息的问题
  - 原因：`index.js` 导出了 `cli.js`，后者在被 import 时自动执行 Commander 程序
  - 修复：改为从子路径 `@larksuiteoapi/lark-mcp/dist/mcp-tool/index.js` 直接导入 `LarkMcpTool`，绕过 CLI 入口
- 成功启动服务：DB、Redis、LarkMCP 全部连接正常，`/health` 端点返回 200
- 新增 WebSocket 长连接模式（`src/gateway/wsGateway.ts`）
  - 原因：飞书开放平台已配置为"长连接"订阅方式，不需要公网 Webhook URL
  - 使用 `@larksuiteoapi/node-sdk` 的 `WSClient` 主动连接飞书，无需 ngrok/cloudflared
  - `WsGateway` 收到事件后桥接到原有 `EventDispatcher`，其余模块无需改动
  - 更新 `src/index.ts`：启动时初始化 `WsGateway` 并建立长连接
- 验证长连接成功：日志显示 `[WsGateway] WebSocket connection established` 和 `ws client ready`
- 飞书消息已成功到达服务（收到 `im.message.receive_v1` 事件），发现两个数据结构不匹配问题并修复：
  - **sender 位置错误**：代码假设 sender 在 message 内部（`event.event.message.sender`），实际飞书传的是 sender 和 message 平级（`event.event.sender`）
  - **user_id 为 null**：飞书返回的 `user_id` 是 null，需要改用 `open_id` 作为用户标识
  - 修复 `src/integration/messageHandler.ts`：从 `event.event.sender` 读取，优先用 `open_id`
  - 修复 `src/gateway/wsGateway.ts` 的 `bridgeEvent`：正确拆分 SDK 传来的扁平数据为 header + event payload
- 修复 Claude API 拒绝飞书 MCP 工具名的问题
  - 原因：飞书 MCP 工具名含 `.`（如 `bitable.v1.app.create`），但 Claude API 只接受 `[a-zA-Z0-9_-]`
  - 修复：在 `src/agent/agentCore.ts` 注册工具时把 `.` 替换为 `_`（如 `bitable_v1_app_create`），调飞书 MCP 时仍用原始名字
- 修复 NotificationService 发送消息失败的问题
  - 原因：MCP 工具 `im.v1.message.create` 没有 callable handler，不能在代码里直接调用
  - 修复：改用 `@larksuiteoapi/node-sdk` 的 Client 直接调飞书 REST API 发消息
- 创建新的纯机器人应用（替代之前的 AI 智能体）
  - 智能体会拦截和改写回复，机器人则直接透传
  - 新机器人发布并审批通过后，完整流程验证成功：消息收发正常，Claude 回复原样到达飞书
- 修复消息重复处理问题（飞书推送同一条消息多次）
  - **问题现象**：发一条消息，后端处理两次甚至无限循环
  - **根因分析**：
    1. 机器人发的回复也会触发 `im.message.receive_v1` 事件（飞书不区分谁发的），导致"收到→回复→收到回复→又回复"的死循环
    2. 飞书长连接断开期间会积压未送达的消息，重连后一次性全部推送（包括很久之前的旧消息）
    3. 网络抖动时飞书会对同一条消息重复推送（相同 `message_id`）
  - **解决方案**：在 `messageHandler.ts` 加三层防护
    1. `sender_type === 'app'` 过滤 → 忽略机器人自身发出的消息，阻断死循环
    2. `create_time` 超过 30 秒的消息直接丢弃 → 阻断旧消息积压重放
    3. `message_id` 去重（内存 Set，最多 500 条）→ 阻断同一条消息被推送两次
  - **关键洞察**：三层防护缺一不可——`message_id` 去重解决不了死循环（每条新回复有不同 ID），`sender_type` 过滤解决不了重复推送（同一条用户消息被推两次）
- 修复消息处理器 session 和超时策略
  - `sessionId` 改为 `message_id`：每条消息独立 session，避免之前失败的上下文污染后续消息（Claude 看到历史失败记录后会拒绝再次尝试）
  - `create_time` 过滤阈值从 30 秒放宽到 5 分钟：飞书推送有网络延迟，30 秒太严格会误杀正常消息

### 今日学习笔记

- 理解了 Webhook 模式 vs 长连接模式的区别：
  - Webhook：飞书主动 POST 到你的服务，需要公网地址
  - 长连接：你的服务主动连飞书 WebSocket，飞书通过这条连接推事件，不需要公网地址
  - 开发阶段用长连接更方便，生产环境两种都可以
- 理解了 `--env-file` 是 Node.js 18+ 内置功能，不需要 `dotenv` 包
- **重要发现：飞书 MCP 不能在代码里直接调用**
  - `@larksuiteoapi/lark-mcp` 是给 MCP Server 模式设计的（比如让 Claude Desktop 通过 MCP 协议调用），工具没有 callable handler
  - `@larksuiteoapi/node-sdk` 的 Client 才是给代码直接调用的 REST API 封装
  - **结论：凡是需要操作飞书的地方（发消息、创建任务、更新文档等），都用 `node-sdk` 的 Client，不用 MCP**
  - 这意味着 `FeishuMcpService` 在当前架构下只用于给 Claude 提供工具列表（描述信息），实际执行要走 REST API

- 理解了飞书"智能体"和"机器人"的区别：
  - 智能体：飞书自己的 AI 在中间拦截消息，改写回复，消息不直接到你的后端
  - 机器人：消息直接到你的后端，你完全控制回复内容
- 实现飞书任务创建功能（AgentCore + 飞书 REST API）
  - **问题**：AgentCore 注册了几十个 MCP 工具给 Claude，但这些工具都不能执行（no callable handler），Claude 反复调用失败后放弃
  - **解决方案**：删掉所有 MCP 工具，只注册一个真正能执行的 `create_feishu_task` 工具，内部直接调 `node-sdk` Client
  - **关键 bug**：`executeTool` 方法调用工具时用了 `tool.invoke({ params: args })`，但新工具的 schema 期望直接传 `args`。这导致工具函数收到的参数全是 undefined，飞书 API 报错
  - **修复**：`tool.invoke({ params: args })` → `tool.invoke(args)`
  - **ESM/CJS 兼容问题**：静态 `import { Client } from '@larksuiteoapi/node-sdk'` 在 ESM 环境下会导致 AgentCore 初始化失败（静默失败，没有错误日志）。改为在 `initialize()` 里用 `await import()` 动态导入解决
  - **session 上下文污染**：Claude 看到之前的失败记录后会拒绝再次尝试工具调用。改为每条消息用独立 session（`sessionId = message_id`）解决
  - **最终架构**：用户消息 → AgentCore → Claude 决定调用 `create_feishu_task` → 工具函数调 `node-sdk` Client → 飞书 REST API 创建任务 → 返回任务 URL → Claude 回复用户
- 更新 taskManager.ts：从 MCP 切换到 REST API
  - 删掉 `FeishuMcpService` 依赖，改用 `@larksuiteoapi/node-sdk` Client
  - `createTask()` 内部调 `client.task.v2.task.create()` 替代 `mcpService.callTool('task_create', ...)`
  - 注意：当前 agentCore 的工具暂时直接调 Client（跳过 taskManager），后续需要改回调 taskManager 以串联数据库和状态管理

- 注册 `analyze_meeting` 工具，将 MeetingAnalyzer 集成到 AgentCore 工作流
  - 把 `meetingAnalyzer.analyze()` 注册为 LangChain 工具，LLM 收到会议纪要时会先调用它进行结构化分析
  - system prompt 明确要求：收到会议内容时**必须先调 analyze_meeting**，拿到结构化行动项后再逐个调 create_feishu_task
  - 这样 meetingAnalyzer 的能力（Zod schema 强制输出格式、长内容分段处理）都能被利用
  - 如果用户直接说"创建任务：xxx"，LLM 判断不是会议内容，跳过分析直接创建

- 完成 AgentCore → TaskManager → 数据库 的完整链路
  - AgentCore 的 `create_feishu_task` 工具改为调用 `taskManager.createTask()`
  - TaskManager 先调飞书 REST API 创建任务，成功后存入本地 PostgreSQL
  - 数据库 `tasks.meeting_id` 改为可选（允许 NULL），支持不关联会议直接创建任务
  - 验证成功：飞书任务创建 + 数据库记录同时完成
  - 待完善：发送会议纪要时应先创建 meeting 记录，再关联到 task

- 实现会议内容保存 + task_meetings 关联
  - `analyze_meeting` 工具分析完后自动将会议原始内容和分析结果存入 `meetings` 表
  - `create_feishu_task` 工具接受 `meeting_id` 参数，创建任务后在 `task_meetings` 表建立关联
  - 验证成功：三张表（meetings、tasks、task_meetings）都有正确数据
- 修复 `task_meetings` INSERT 报错 "Insert did not return a row"
  - **根因**：`insert` 工具函数要求 SQL 必须返回行（`RETURNING` 子句），但 `ON CONFLICT DO NOTHING` 在冲突时不返回任何行
  - **修复**：改用 `query` 函数（不检查返回行数）代替 `insert` 函数
  - **教训**：`insert` 函数只适合确定会返回行的 INSERT，带 `ON CONFLICT DO NOTHING` 的要用 `query`
- 在 messageHandler 中追加任务 URL 列表到回复末尾（折中方案：Claude 正常回复 + 代码硬性追加链接）


---

## 2026-05-16（周六）

### 今日完成内容

- 完成代码清理：移除 `feishuMcp.ts` 和 `feishuAuth.ts` 及其测试文件
  - **原因**：`@larksuiteoapi/lark-mcp` 是 MCP Server 模式设计的，工具没有 callable handler，不能在代码里直接调用。所有飞书操作已统一改用 `@larksuiteoapi/node-sdk` Client 直接调 REST API。`FeishuAuthService` 只被 `FeishuMcpService` 引用，node-sdk Client 内部自己管理认证，所以也不再需要
  - 删除文件：`src/services/feishuMcp.ts`、`src/services/feishuMcp.test.ts`、`src/services/feishuAuth.ts`、`src/services/feishuAuth.test.ts`
  - 从 `package.json` 移除 `@larksuiteoapi/lark-mcp` 依赖
- 清理 `agentCore.ts` 中的 MCP 残留
  - 移除 `FeishuMcpService` import、字段、构造函数参数
  - 移除 `executeTool` 中的 MCP fallback 路径（不存在的工具现在直接返回错误信息，不再尝试调 MCP）
- 清理 `notification.ts` 中的 MCP 残留
  - 移除 `FeishuMcpService` import 和字段（实际发消息已经用 node-sdk Client）
  - 新增 `feishuClient` 选项用于测试注入
- 修复 `taskManager.ts` 中的遗留问题
  - `splitTask` 方法从 MCP 调用改为 REST API（`client.task.v2.task.create()`）
  - 移除 `splitTask` 中对已删除的 `meeting_id` 列的引用
  - 移除 `listTasks` 中对已删除的 `meetingId` 过滤条件
- 重写测试文件以匹配新架构
  - `agentCore.test.ts`：移除所有 MCP 相关 mock，改为 mock `@larksuiteoapi/node-sdk`，17 个测试全部通过
  - `notification.test.ts`：移除 MCP mock，改为测试 node-sdk Client 调用，15 个测试全部通过
- 确认 Task 17.1 已完成：`create_feishu_task` 工具已经调用 `TaskManager.createTask()`，走完整流程（飞书 REST API + DB 持久化 + 状态初始化）
- 全量测试结果：376 个测试通过，29 个预存失败（`taskManager.test.ts` 缺少 config mock，属于 Task 17.5 范围）

### 架构决策

- **最终架构确认**：AgentCore 工具函数 → Service 层（TaskManager / MeetingAnalyzer 等）→ node-sdk Client（飞书 REST API）+ db.ts（PostgreSQL）
- MCP 在当前架构中没有位置，`@larksuiteoapi/lark-mcp` 完全移除
- `feishuMcp.ts` 和 `feishuAuth.ts` 是废代码，已清理

- 注册 5 个新 AgentCore 工具（Task 17.2）
  - `list_tasks`：按状态/优先级/分配人查询任务列表
  - `get_task`：查询单个任务详情（支持 UUID 和 display_id 查询）
  - `update_task`：修改任务描述（保留历史记录）
  - `assign_task`：分配任务给开发者（调 TaskAssignmentService）
  - `complete_task`：标记任务完成（调状态机）
- 实现 display_id（人类可读任务编号）
  - 格式：`F-000001`（新功能）、`B-000001`（Bug修复）
  - 使用 PostgreSQL sequence（`task_display_id_seq`）保证唯一递增
  - 创建任务流程改为：先写 DB 拿 display_id → 再调飞书 API（标题格式：`F-000001-任务标题`）→ 更新 DB 存 feishu_task_id
  - 修复 PostgreSQL 参数类型推断冲突（`$10` 在 subquery 中类型歧义），改为 JS 侧计算前缀后传入
- 合并 3 个 migration 文件为单一 `migrations/schema.sql`
- 更新 Task model 新增 `displayId` 和 `taskType` 字段
- 回填旧任务的 display_id（F-000001 到 F-000012）

- 修复飞书任务创建时缺少截止日期的问题
  - `TaskCreateParams` 新增 `dueDate` 字段（YYYY-MM-DD 格式）
  - `TaskManager.createTask()` 将 dueDate 转为飞书 API 要求的格式（毫秒时间戳 + `is_all_day: true`）
  - AgentCore 的 `create_feishu_task` 工具将 `due_date` 参数传递给 TaskManager

- 创建 `employees` 表（手动维护团队花名册）
  - 字段：open_id、name、status（active/on_leave/inactive）
  - 用于将人名映射到飞书 open_id
- 新增 `lookup_employee` 工具（Tool 8）
  - LLM 自己决定何时查询员工表，而不是代码硬编码查询逻辑
  - 支持精确匹配和模糊匹配（输入"秉麟"能找到"刘秉麟"）
- 重构 assignee 相关逻辑
  - `create_feishu_task`：新增可选 `assignee` 参数（名字），内部查 employees 表拿 open_id
  - `assign_task`：改为接受 open_id（LLM 先调 lookup_employee 获取）
  - `list_tasks`：assignee 过滤改为接受 open_id（LLM 先调 lookup_employee 获取）
  - `TaskManager.createTask()`：移除硬编码的 open_id，改为可选参数传入
- 更新 system prompt：告知 LLM employees 表的存在和查询流程
- 设计理念：让 LLM 自己编排多步查询（先查人再查任务），而不是代码替它做

- 新增 `query_sql` 通用只读查询工具，替代 `list_tasks`、`get_task`、`lookup_employee`
  - LLM 可以自由写 SELECT 查询任何数据（tasks、employees、meetings 等）
  - 安全限制：只允许 SELECT，拒绝 INSERT/UPDATE/DELETE/DROP 等关键字
  - 结果限制最多 20 行，防止 token 爆炸
  - system prompt 包含完整数据库 schema，LLM 知道所有表和列
- 精简工具集为 6 个：analyze_meeting、query_sql、create_feishu_task、update_task、assign_task、complete_task
- `create_feishu_task` 工具完善
  - 新增 `acceptance_criteria`、`dependencies`、`priority`、`assignee_open_id` 字段
  - 移除内部查询代码，LLM 自己用 query_sql 先查好数据再传入
- 数据库新增 `due_date` 列，创建任务时同时存到本地 DB 和飞书 API
- 设计理念：查询完全交给 AI 自由发挥（query_sql），增删改走受控的专用工具

- `update_task` 工具完善
  - 支持修改：title、description、priority、due_date、acceptance_criteria
  - 飞书同步：每次更新都同步 summary + description + due 到飞书
  - 描述格式由 LLM 控制（总概括 + 要点 + 变更历史），代码只负责原样存储和同步
  - system prompt 明确要求 LLM 更新描述时遵循格式规范，保留原有内容，只追加变更历史
  - 移除代码层面的历史拼接逻辑，避免重复

- `assign_task` 工具完善
  - 新增 `reason` 参数（可选），记录分配/重新分配原因
  - 人员变更写入 `description_history`（变更历史追踪）
  - 同步到飞书：调 `addMembers` API 把人加到飞书任务负责人列表
- 调研飞书任务变更事件订阅
  - 发现飞书的"动态订阅"是基于清单（Tasklist）的，推送到群，不是推送到应用后端
  - 飞书目前没有任务级别的变更 Webhook 事件
  - 待定：考虑方案 B（读时同步：操作前先从飞书 API 拉最新状态）

- 实现 `advance_task` 工具（替代 complete_task）
  - 通用状态推进工具，支持所有合法的工作流事件
  - 事件列表：assigned、confirmed、dev_complete、verification_passed、qa_passed、doc_updated、completed、qa_failed_impl、qa_failed_req、verification_failed
  - 智能跳步：如果 confirmed 时任务还在 Created，自动先走 Created → Assigned
  - assign_task 也会自动推进 Created → Assigned
  - create_feishu_task 带 assignee 时自动推进到 Assigned
- 修复乐观锁并发冲突
  - 原因：快速连续两步状态转换时，`WHERE updated_at = $5` 匹配不到（第一步改了 updated_at）
  - 修复：乐观锁改为 `WHERE state = $5`（检查状态而非时间戳）
- 修复 query_sql 关键字误判
  - 原因：`updated_at` 被误判为包含 `UPDATE` 关键字
  - 修复：改用正则 `\b` 词边界匹配，并从禁止列表移除 UPDATE（SELECT 里常用 updated_at）
- 抽取工具定义到 `src/agent/agentCoreToolBoxRegister.ts`
  - agentCore.ts 只保留核心逻辑（LLM 调用、会话管理、tool-calling loop）
  - 工具定义独立文件，方便维护和扩展
- 更新 system prompt：明确要求 LLM 分配人时先 assign_task 再 advance_task


---

## 2026-05-17（周日）

### 今日完成内容

- 完成 17.3.1：实现 `advance_task` 工具（替代 complete_task）
  - 通用状态推进工具，支持 10 种工作流事件
  - 智能跳步逻辑：
    - `confirmed` 从 Created 状态时自动先走 Created → Assigned → InDevelopment（两步）
    - `qa_failed_impl` / `qa_failed_req` 从 QAPending 时自动先走 QAPending → QAFailed → InDevelopment/Created（两步）
  - 修复乐观锁并发冲突：将 `WHERE updated_at = $5` 改为 `WHERE state = $5`，解决快速连续状态转换时的竞态条件
  - 修复 query_sql 关键字误判：`updated_at` 列名不再被误判为 UPDATE 关键字（改用正则词边界匹配）
  - 更新 system prompt：明确要求 LLM 分配人时先 assign_task 再 advance_task

- 完成 17.3.2：实现 `verify_code` 工具
  - 接受可选的 `code_changes` 参数（git diff）
  - 有代码时调 CodeVerifier 做 AI 分析，没代码时基于需求生成参考报告
  - 无论验证结果如何都自动通过（per 设计文档：AI 验证不阻塞流程）
  - 自动推进状态：InDevelopment → VerificationPending → VerificationPassed
  - 验证报告自动存入 verification_reports 表

- 完成 17.3.3：实现 `generate_test_doc` 工具
  - 调 DocGenerator.generateTestDocument() 生成正向/负向/边界测试用例
  - 修复 `Cannot read properties of undefined (reading 'length')` 错误：确保 acceptanceCriteria 始终为数组，空时用任务标题作为默认验收标准
  - 传完整 Task 对象给 DocGenerator（补全所有必需字段）
  - 测试文档存入 documents 表
  - 测试文档格式化为 markdown 后作为附件上传到飞书任务（调 attachment.upload API）
  - 自动推进状态：VerificationPassed → QAPending

- 代码重构：抽取工具定义到 `src/agent/agentCoreToolBoxRegister.ts`
  - agentCore.ts 从 ~800 行精简到 ~300 行，只保留核心逻辑
  - 工具定义独立文件，方便后续扩展（如添加 submit_qa_feedback）

- 完整工作流已验证通过：
  - 创建任务 → 分配 → 确认开始 → 开发完成 → AI 验证 → 生成测试文档 → QA 通过/失败 → 回退/推进
  - 所有状态转换都写入 workflow_logs 表
  - 飞书同步：创建/更新/分配/附件上传

### 当前工具集（8 个）

1. `analyze_meeting` — 分析会议内容，存 DB
2. `query_sql` — 通用只读 SQL 查询
3. `create_feishu_task` — 创建任务（DB + 飞书 API + 自动 Assigned）
4. `update_task` — 更新任务字段（DB + 飞书同步）
5. `assign_task` — 分配任务（DB + 飞书 addMembers + 自动 Assigned）
6. `advance_task` — 通用状态推进（状态机校验 + workflow_logs）
7. `verify_code` — AI 代码验证（可选代码 + 自动推进）
8. `generate_test_doc` — 生成测试文档（存 DB + 飞书附件）

- 简化状态机：移除 Verification 阶段（VerificationPending、VerificationPassed、VerificationFailed）
  - 原因：从 InDevelopment 到 QA 之间的验证步骤是 AI 内部一瞬间完成的，用户感知不到中间状态，没必要占 3 个状态
  - 新流程：Created → Assigned → InDevelopment → QAPending → QAPassed → DocumentationUpdated → Completed
  - `dev_complete` 事件直接从 InDevelopment 跳到 QAPending
  - `verify_code` 工具改为只生成报告（给 QA 参考），不再推进状态
  - `generate_test_doc` 从 InDevelopment 直接推进到 QAPending
  - TaskState 类型移除 3 个 Verification 状态
  - stateMachine.test.ts 有 14 个旧测试需要更新（待修复）
- 完成 17.3.4：实现 `submit_qa_feedback` 工具
  - 一站式工具：存 QA 反馈到 qa_feedbacks 表 + 自动推进状态
  - 通过 → QAPassed；失败（实现错误）→ QAFailed → InDevelopment；失败（需求错误）→ QAFailed → Created
  - system prompt 明确要求：QA 反馈先调 submit_qa_feedback，再调 update_task 更新描述

- 进一步简化状态机：移除 DocumentationUpdated 状态
  - 最终流程：Created → Assigned → InDevelopment → QAPending → QAPassed → Completed
  - QA 通过后自动完成任务（QAPending → QAPassed → Completed 一步到位）
  - submit_qa_feedback 结果为 passed 时也自动完成
  - 迁移了旧的 VerificationPassed 状态任务到 QAPending

- 实现 `syncDescriptionToFeishu` 统一方法
  - 每次事件发生时自动追加到 description_history 并同步完整描述（内容 + 历史）到飞书
  - 在 create_feishu_task、assign_task、update_task、submit_qa_feedback 中自动调用
  - LLM 不再在描述里写变更历史，只写内容；历史由代码自动管理
  - 修复重复历史记录：update_task 改描述时不再双重记录
- 完成 17.3.4：`submit_qa_feedback` 工具 + 状态守卫
  - 如果任务不在 QAPending 状态则拒绝（防止 LLM 在 InDevelopment 状态误用）
  - 返回有用的错误信息引导 LLM 使用 update_task
- 修复 CodeVerifier 尝试推进到已删除的 VerificationPassed 状态
  - 移除 CodeVerifier.verify() 中的 advanceTaskWorkflow 调用，现在只生成报告
- 修复 system prompt：明确 submit_qa_feedback 只用于 QAPending 状态，其他状态用 update_task

- QA 失败统一回退到 InDevelopment（不再区分回退到 Created）
  - 原因：已分配的任务回到 Created 不合理；需求变更可以通过 update_task 处理
  - failure_type 仍然记录在 qa_feedbacks 表（方便统计），但状态统一回到 InDevelopment

---

## 2026-05-18（周一）

### 今日完成内容

- 完成 Task 17.4：飞书数据同步

- 实现 `FeishuSyncService`（`src/services/feishuSync.ts`）
  - **架构决策**：`FeishuSyncService` 是纯只读的"侦察员"，只负责对比飞书和本地 DB 的差异，不写任何东西
  - 对外暴露单一方法 `diff(taskId)`：拉飞书 API → 查 DB → 返回差异列表（`SyncDiff[]`）
  - 支持 UUID 和 display_id（如 F-000001）两种输入格式
  - 对比字段：title、description、due_date、assignee_id
  - description 对比时自动剥离 `--- 变更历史 ---` 分隔符后的历史段，只比较用户内容部分
  - due_date 对比时统一格式化为 YYYY-MM-DD，避免 pg 返回 Date 对象导致误报
  - state 字段**不同步**：状态只能通过状态机（advance_task / submit_qa_feedback）改变
  - 14 个单元测试全部通过

- 注册 `sync_task` 工具（Tool 10）到 AgentCore
  - 用户说"我在飞书上改了点东西，同步一下" → Agent 调 `sync_task`
  - 工具调用 `FeishuSyncService.diff()` 拿到差异列表，返回给 LLM
  - LLM 根据差异决定调哪些工具：title/description/due_date 变了 → 调 `update_task`；assignee 变了 → 调 `assign_task`
  - 这样历史记录、飞书同步、状态机都走正常流程，不会出现乱格式问题

- 修复 `sync_task` 两个 bug（从实际运行日志发现）：
  1. **due_date 误报**：pg 返回 Date 对象，直接和飞书的 YYYY-MM-DD 字符串比较导致误判为"有变更"。修复：`normalizeDateString()` 统一格式化后再比较
  2. **state 被飞书覆盖**：飞书任务标记完成后，sync 把本地状态直接改成 Completed，绕过了状态机。修复：`detectChanges` 中完全移除 state 同步逻辑

- 移除 `last_synced_at` 字段
  - 节流控制用内存 `lastSyncMap` 就够了，不需要持久化到 DB
  - 从 `migrations/schema.sql` 和所有相关代码中移除

- 重构历史：经历了三个版本的设计演进
  1. **版本 1**（复杂）：FeishuSyncService 自己写 DB + 写飞书描述，导致飞书描述重复乱格式
  2. **版本 2**（中间）：FeishuSyncService 写 DB 但不写飞书，由 sync_task 工具调 syncDescriptionToFeishu，仍有格式问题
  3. **版本 3（当前）**：FeishuSyncService 纯只读，只返回 diff，由 LLM 决定调哪些工具处理变更

### 架构决策

- **sync_task 是侦察工具，不是执行工具**：发现变更后告诉 LLM，LLM 用已有工具（update_task、assign_task）处理
- **acceptance_criteria 不再独立维护**：该字段与 description 经常不同步，且飞书 API 不返回此字段。决定在下次提交中废弃，改为直接从 description 推断验收标准
