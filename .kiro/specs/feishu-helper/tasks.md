# Implementation Plan: Feishu Helper

## Overview

基于事件驱动架构，使用 TypeScript + Fastify + LangChain.js + 飞书 MCP 实现飞书工作流自动化系统。从项目初始化开始，逐步搭建核心模块，最终完成完整工作流闭环。

## Tasks

- [-] 1. 项目初始化与基础设施搭建
  - [x] 1.1 初始化 Node.js 项目并配置 TypeScript
    - 创建 `package.json`，配置 TypeScript 编译选项（`tsconfig.json`）
    - 安装核心依赖：`fastify`, `langchain`, `@larksuiteoapi/lark-mcp`, `bullmq`, `pg`, `ioredis`
    - 安装开发依赖：`typescript`, `vitest`, `fast-check`, `eslint`, `prettier`
    - 配置 ESLint + Prettier 规则
    - 创建 `src/` 目录结构：`src/gateway/`, `src/agent/`, `src/workflow/`, `src/services/`, `src/models/`, `src/utils/`, `src/config/`
    - _Requirements: 10.1_

  - [x] 1.2 配置数据库与 Schema 迁移
    - 创建数据库迁移脚本，包含所有表：`meetings`, `tasks`, `workflow_logs`, `task_assignments`, `verification_reports`, `qa_feedbacks`, `documents`
    - 实现数据库连接池配置（`src/config/database.ts`）
    - 创建基础的数据库查询工具函数
    - _Requirements: 9.1, 9.2_

  - [x] 1.3 配置环境变量与应用配置
    - 创建 `src/config/index.ts`，定义所有配置项（飞书 App ID/Secret、LLM API Key、数据库连接、Redis 连接等）
    - 创建 `.env.example` 模板文件
    - 实现配置验证逻辑，启动时检查必要配置是否存在
    - _Requirements: 10.1, 10.4_

- [x] 2. 核心类型定义与错误处理
  - [x] 2.1 定义核心 TypeScript 接口和类型
    - 创建 `src/models/task.ts`：Task, SubTask, TaskState, TaskCreateParams 等类型
    - 创建 `src/models/meeting.ts`：Meeting, MeetingAnalysis, ActionItem, MeetingSummary 等类型
    - 创建 `src/models/workflow.ts`：WorkflowEvent, WorkflowStatus, StateTransition 等类型
    - 创建 `src/models/verification.ts`：VerificationReport, CodeContext, Discrepancy 等类型
    - 创建 `src/models/document.ts`：TestDocument, TestCase, MDDocument, UserManual 等类型
    - 创建 `src/models/index.ts` 统一导出
    - _Requirements: 2.3, 4.2, 5.3, 9.1_

  - [x] 2.2 实现统一错误处理框架
    - 创建 `src/utils/errors.ts`：定义 AppError 类、ErrorCategory 枚举
    - 创建 `src/utils/retry.ts`：实现指数退避重试策略（RetryPolicy, withRetry 函数）
    - 实现错误分类逻辑：feishu_api, llm_service, state_transition, validation, business_logic
    - _Requirements: 1.4, 2.6, 10.2, 10.5_

  - [ ]* 2.3 编写指数退避重试的 Property Test
    - **Property 16: Exponential Backoff Retry**
    - 验证对于 N 次连续失败，第 K 次重试延迟与 2^K 成正比
    - **Validates: Requirements 10.2**

- [-] 3. 状态机与工作流引擎
  - [x] 3.1 实现任务状态机
    - 创建 `src/workflow/stateMachine.ts`：定义合法状态转换表
    - 实现 `validateTransition(fromState, toState): boolean` 函数
    - 实现 `transition(taskId, toState, context): Promise<boolean>` 函数，包含乐观锁
    - 实现状态转换日志记录（写入 `workflow_logs` 表）
    - 实现重试计数器递增逻辑（失败回退时）
    - _Requirements: 9.1, 9.2, 9.3, 9.4_

  - [ ]* 3.2 编写状态机正确性的 Property Test
    - **Property 12: State Machine Correctness**
    - 生成随机状态和转换序列，验证只有合法转换成功，非法转换被拒绝且不修改状态
    - **Validates: Requirements 9.1, 9.3**

  - [ ]* 3.3 编写状态转换日志的 Property Test
    - **Property 13: State Transition Logging**
    - 生成随机转换序列，验证每次成功转换都产生包含 from-state, to-state, trigger, actor, timestamp 的日志
    - **Validates: Requirements 9.2**

  - [ ]* 3.4 编写重试计数器的 Property Test
    - **Property 14: Retry Counter on Failure Revert**
    - 生成随机失败序列，验证每次失败回退时计数器递增 1，且 failureContext 非空
    - **Validates: Requirements 9.4**

  - [x] 3.5 实现工作流引擎
    - 创建 `src/workflow/workflowEngine.ts`：实现 WorkflowEngine 接口
    - 实现 `startWorkflow`：从会议分析结果启动工作流
    - 实现 `advanceWorkflow`：根据事件推进工作流
    - 实现 `revertWorkflow`：回退工作流到指定状态
    - 实现会议更新触发回退逻辑（任何超过 Created 状态的任务回退到 Created）
    - _Requirements: 9.1, 9.5, 9.6_

  - [ ]* 3.6 编写会议更新回退的 Property Test
    - **Property 15: Meeting Update Triggers Revert**
    - 生成各状态的任务，验证会议更新时超过 Created 状态的任务正确回退
    - **Validates: Requirements 9.5**

- [x] 4. Checkpoint - 确保状态机和工作流引擎测试通过
  - 确保所有测试通过，如有问题请向用户确认。

- [x] 5. Webhook Gateway 与飞书集成
  - [x] 5.1 实现 Webhook Gateway
    - 创建 `src/gateway/webhookGateway.ts`：实现 Fastify 路由
    - 实现飞书事件签名验证（`verifySignature`）
    - 实现 URL Challenge 验证（飞书注册 Webhook 时的验证请求）
    - 实现事件分发逻辑：根据 event_type 路由到对应处理器
    - 处理消息事件（`im.message.receive_v1`）和卡片回调事件
    - _Requirements: 10.1, 10.4_

  - [x] 5.2 实现飞书认证与 Token 管理
    - 创建 `src/services/feishuAuth.ts`：实现 OAuth 2.0 / App 凭证认证
    - 实现 Token 自动刷新逻辑（过期前主动刷新）
    - 实现 Token 缓存（Redis）
    - _Requirements: 10.1, 10.3_

  - [x] 5.3 配置飞书 MCP 集成
    - 创建 `src/services/feishuMcp.ts`：初始化 `@larksuiteoapi/lark-mcp` 客户端
    - 封装 MCP 工具调用接口，统一错误处理和重试
    - 实现 API 限流处理（指数退避）
    - _Requirements: 10.1, 10.2, 10.5_

- [x] 6. AI Agent Core 与会议分析
  - [x] 6.1 实现 AI Agent Core
    - 创建 `src/agent/agentCore.ts`：基于 LangChain.js 实现 Agent
    - 配置 LLM Provider（支持 OpenAI GPT-4 / Claude）
    - 注册飞书 MCP 工具到 Agent
    - 实现会话上下文管理（`getContext`）
    - 实现 Agent 输入处理和动作输出逻辑
    - _Requirements: 1.2, 2.1_

  - [x] 6.2 实现 Meeting Analyzer
    - 创建 `src/services/meetingAnalyzer.ts`：实现会议纪要分析
    - 实现 `analyze(content)`：调用 LLM 生成结构化分析结果
    - 实现 `extractActionItems(content)`：提取行动项，包含优先级、建议分配人、依赖关系
    - 实现 `generateSummary(content)`：生成包含关键决策、讨论要点的摘要
    - 处理超长会议内容（分段处理，避免截断）
    - 处理空内容和 API 失败的错误情况
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5_

  - [ ]* 6.3 编写 Meeting Analyzer 单元测试
    - 测试结构化输出解析逻辑
    - 测试空内容处理
    - 测试错误情况处理
    - _Requirements: 1.2, 1.4, 1.5_

- [x] 7. 任务管理模块
  - [x] 7.1 实现 Task Manager
    - 创建 `src/services/taskManager.ts`：实现任务 CRUD 操作
    - 实现 `createTask`：通过飞书 MCP 创建任务，写入数据库
    - 实现 `splitTask`：将复杂任务拆分为子任务，确保范围不重叠
    - 实现 `updateTaskDescription`：更新描述并保留历史记录（reason + timestamp）
    - 实现 `updateTaskState`：调用状态机执行状态转换
    - 实现创建失败重试逻辑（最多 3 次）
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6_

  - [ ]* 7.2 编写任务描述历史保留的 Property Test
    - **Property 4: Task Description History Preservation**
    - 生成随机更新序列，验证历史记录完整性（N 次更新产生 N 条历史）
    - **Validates: Requirements 2.5**

  - [x] 7.3 实现任务分配管理
    - 创建 `src/services/taskAssignment.ts`：实现分配关系管理
    - 实现分配记录创建和查询
    - 实现分配状态维护（active, reassigned, completed）
    - 实现分配确认后开始监控任务状态
    - _Requirements: 3.1, 3.2, 3.3_

  - [ ]* 7.4 编写任务分配映射一致性的 Property Test
    - **Property 5: Assignment Mapping Consistency**
    - 生成随机分配序列，验证映射正确性
    - **Validates: Requirements 3.1, 3.3**

- [x] 8. Checkpoint - 确保任务管理模块测试通过
  - 确保所有测试通过，如有问题请向用户确认。

- [x] 9. 代码验证模块
  - [x] 9.1 实现 Code Verifier
    - 创建 `src/services/codeVerifier.ts`：实现代码验证逻辑
    - 实现 `verify(taskId, codeContext)`：调用 LLM 对比代码与任务描述
    - 生成 VerificationReport：包含 matchScore、matchedCriteria、unmatchedCriteria、discrepancies、recommendations
    - **无论 AI 验证结果如何，任务都推进到 VerificationPassed（进入 QA）**，AI 的 score 和 discrepancies 作为参考信息带给 QA
    - 实现需求模糊时的标记和建议逻辑（status: ambiguous）
    - 将验证报告持久化到 `verification_reports` 表
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5_

  - [ ]* 9.2 编写验证报告结构的 Property Test
    - **Property 6: Verification Report Structure**
    - 验证任何验证操作都产生完整的报告结构，matched + unmatched = 全部验收标准
    - **Validates: Requirements 4.2**

- [x] 10. 文档生成模块
  - [x] 10.1 实现测试文档生成
    - 创建 `src/services/docGenerator.ts`：实现 DocGenerator 接口
    - 实现 `generateTestDocument(task)`：基于验收标准生成测试用例
    - 确保包含正向测试、负向测试、边界条件测试
    - 每个测试用例包含前置条件、测试步骤、预期结果
    - 处理任务描述不足时的信息缺失标记
    - _Requirements: 5.1, 5.2, 5.3, 5.4_

  - [ ]* 10.2 编写测试文档完整性的 Property Test
    - **Property 7: Test Document Completeness**
    - 验证生成的测试文档包含至少一个正向、负向、边界测试用例，且字段非空
    - **Validates: Requirements 5.1, 5.2, 5.3**

  - [ ] ~~10.3 实现 MD 文档更新~~ (已跳过 - 不需要)
    - ~~实现 `updateMDDocument(docId, content)`：更新现有文档的相关章节~~
    - ~~保留原有文档结构，仅修改相关部分~~
    - ~~自动更新版本号和 last-updated 时间戳~~
    - ~~文档不存在时创建新文档~~
    - _Requirements: 7.1, 7.2, 7.3, 7.4_

  - [ ]* 10.4 编写文档更新保留的 Property Test
    - **Property 9: Document Update Preservation**
    - 生成随机文档和更新，验证原有章节保留、版本递增、时间戳更新
    - **Validates: Requirements 7.2, 7.3**

  - [ ] ~~10.5 实现使用手册编译~~ (已跳过 - 不需要)
    - ~~实现 `compileUserManual(docIds)`：将多个 MD 文档编译为结构化手册~~
    - ~~生成目录、章节导航、交叉引用~~
    - ~~支持 Web 发布和 PDF 导出格式~~
    - ~~实现增量更新：仅重新生成受影响的章节~~
    - _Requirements: 8.1, 8.2, 8.3, 8.4_

  - [ ]* 10.6 编写使用手册编译完整性的 Property Test
    - **Property 10: User Manual Compilation Completeness**
    - 验证 N 个文档编译后手册包含所有文档内容、目录条目和交叉引用
    - **Validates: Requirements 8.1, 8.2**

  - [ ]* 10.7 编写使用手册增量更新的 Property Test
    - **Property 11: User Manual Incremental Update**
    - 验证单个文档更新后仅修改相关章节，其余章节保持不变
    - **Validates: Requirements 8.4**

- [x] 11. QA 反馈处理
  - [x] 11.1 实现 QA 反馈处理逻辑
    - 创建 `src/services/qaFeedback.ts`：实现 QA 结果处理
    - 实现 QA 通过处理：标记任务为 QA-Passed，触发文档更新
    - 实现 QA 失败处理：根据失败类型路由（需求错误 → 回到会议讨论，实现错误 → 回到开发）
    - 记录所有 QA 反馈并关联到对应任务
    - _Requirements: 6.1, 6.2, 6.3, 6.4_

  - [ ]* 11.2 编写 QA 反馈关联的 Property Test
    - **Property 8: QA Feedback Association**
    - 验证提交的 QA 反馈正确关联到任务，查询时能返回
    - **Validates: Requirements 6.4**

- [x] 12. Checkpoint - 确保所有模块测试通过
  - 确保所有测试通过，如有问题请向用户确认。

- [x] 13. 消息队列与异步工作流
  - [x] 13.1 配置 BullMQ 任务队列
    - 创建 `src/queue/index.ts`：配置 BullMQ 连接和队列定义
    - 定义队列：`meeting-analysis`, `task-creation`, `code-verification`, `doc-generation`, `notification`
    - 实现 Worker 处理器，连接到对应的服务模块
    - 实现失败重试和死信队列处理
    - _Requirements: 2.6, 10.2_

  - [x] 13.2 实现通知服务
    - 创建 `src/services/notification.ts`：通过飞书 MCP 发送消息通知
    - 实现任务分配通知、状态变更通知、需求变更通知
    - 实现通知失败时的队列重试
    - _Requirements: 3.2, 9.6_

- [x] 14. 端到端集成与应用入口
  - [x] 14.1 实现应用启动入口
    - 创建 `src/app.ts`：Fastify 应用初始化，注册路由和插件
    - 创建 `src/index.ts`：应用启动入口，初始化数据库连接、Redis、BullMQ
    - 实现优雅关闭（graceful shutdown）
    - 实现健康检查端点（`/health`）
    - _Requirements: 10.1_

  - [x] 14.2 集成所有模块完成完整工作流
    - 连接 Webhook Gateway → Agent Core → 各服务模块 → 工作流引擎
    - 实现完整流程：消息接收 → 会议分析 → 任务创建 → 状态流转 → 文档生成
    - 确保所有模块正确协作，无孤立代码
    - _Requirements: 1.1-1.5, 2.1-2.6, 3.1-3.3, 4.1-4.5, 5.1-5.4, 6.1-6.4, 7.1-7.4, 8.1-8.4, 9.1-9.6, 10.1-10.5_

  - [ ]* 14.3 编写集成测试
    - 测试完整工作流：会议上传 → 任务创建 → 分配 → 验证 → QA → 文档
    - 使用 mock 飞书 MCP 和 mock LLM 响应
    - 测试异常流程：API 失败重试、状态回退
    - _Requirements: 9.1-9.6_

- [x] 15. Final Checkpoint - 确保所有测试通过
  - 确保所有测试通过，如有问题请向用户确认。

## Notes

- 标记 `*` 的任务为可选任务，可跳过以加速 MVP 开发
- 每个任务引用了具体的需求编号，确保可追溯性
- Checkpoint 任务确保增量验证，及早发现问题
- Property Tests 使用 `fast-check` 库验证核心业务规则的正确性
- 所有代码使用 TypeScript，遵循项目 rules.md 中的命名规范
