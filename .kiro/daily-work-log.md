# Daily Work Log

## 2026-05-31 (Saturday)

### ✅ 接入 LangSmith LLM Tracing
**Summary:** 接入 LangSmith 实现 LLM 交互追踪，只需加环境变量，不需要改代码。可以在 LangSmith 网页上看到每次 LLM 调用的完整链路。

<details>
<summary>
<strong>📖 Click to expand full details</strong>
</summary>

**做了什么：**
- 在 `.env` 里加了 3 行环境变量（LANGCHAIN_TRACING_V2、LANGCHAIN_API_KEY、LANGCHAIN_PROJECT）
- LangChain 内部检测到这些变量后，自动把所有 LLM 调用和 tool call 的 trace 发送到 LangSmith 云端
- 不需要改任何代码

**为什么不需要改代码：**
- LangChain 的 `initChatModel`、`bindTools`、`invoke` 等方法内部都有 tracing hook
- 当 `LANGCHAIN_TRACING_V2=true` 时自动激活，否则什么都不做
- `DynamicStructuredTool.invoke()` 也会被自动 trace（记录 tool 输入参数和返回结果）

**能看到什么：**
- ✅ 用户发了什么消息
- ✅ LLM 决定调哪些 tool（tool_calls 列表）
- ✅ 每个 tool 的输入参数和返回结果
- ✅ LLM 的最终回复
- ✅ token 用量、延迟、成本
- ❌ tool 内部的中间步骤（比如先调了飞书 API 再写了数据库）

**方案对比（为什么选 LangSmith）：**

| 方案 | 存储 | 可视化 | 复杂度 |
|------|------|--------|--------|
| PostgreSQL 自建 | 存 PG | 需要自己写查询 | 中 |
| Loki + Grafana | 存 Loki | 通用日志面板 | 中（要装 Loki） |
| LangSmith | 云端 | 专为 LLM 设计的树状调用链 | 低（加环境变量） |

**LangSmith 免费版：** 每月 5000 条 trace，对个人项目绰绰有余。

**关键概念：**
- Grafana 本身不存数据，只是可视化面板
- Loki 是 Grafana 团队的日志系统，适合通用日志
- LangSmith 是 LangChain 官方的 LLM 追踪工具，专为 AI Agent 设计

**Thread 分组：**
- 默认 LangSmith 显示扁平列表（每个 LLM 调用和 tool 调用独立一行），看不出哪些属于同一次对话
- 需要在 `llm.invoke()` 时传 `metadata: { thread_id: sessionId }`，LangSmith 才能按对话分组
- 修改了 `agentCore.ts` 的 `invokeLlm` 方法，传入 sessionId 作为 thread_id
- 修改后在 LangSmith 的 "Threads" 标签可以按对话查看完整调用链

**关于 token 消耗：**
- 每次 tool-calling loop 里调 LLM，都会把完整 messages 数组（包括 system prompt）重新发一遍
- 4 轮调用 = system prompt 发了 4 次，这不是浪费，是 LLM API 的工作方式决定的
- LLM 没有持久记忆，每次 invoke 对它来说都是全新的对话，不带 system prompt 就不知道规则
- Anthropic 有 prompt caching：相同 system prompt 重复发送时，第二次开始只收 10% token 费用
- Agent 也是 LLM，只是多了 tool calling 循环，底层每一轮都是完整的 API 调用

</details>

---

## 2026-05-28 (Wednesday)

### 🔍 CI/CD 自动部署方案对比
**Summary:** 学习了两种 CI/CD 自动部署方案的区别和流程，为后续实现做准备。

<details>
<summary>
<strong>📖 Click to expand full details</strong>
</summary>

#### 方案一：简单版（SSH 直接部署）

**流程：**
```
本地 push 代码 → GitHub Actions 触发 → SSH 到服务器 → git pull + docker compose up --build
```

**特点：**
- 构建在服务器上完成（服务器跑 Dockerfile 里的 npm ci + tsc）
- 不需要镜像仓库
- 配置简单，一个 yml 文件搞定
- 缺点：构建时占用服务器资源，构建期间服务可能短暂中断

**适合：** 个人项目、小团队、服务器资源够用的情况

---

#### 方案二：标准版（镜像仓库流程）

**流程：**
```
本地 push 代码
  → GitHub Actions（或 Jenkins）触发
  → 在 CI 服务器上 install + build（生成 dist）
  → 把 dist 打包成 Docker image
  → 把 image push 到镜像仓库（Docker Hub / GitHub Container Registry / Harbor）
  → 通知服务器从镜像仓库 pull 新 image
  → 服务器用新 image 替换旧容器
```

**特点：**
- 构建在 CI 服务器上完成（不占用生产服务器资源）
- image 存在镜像仓库里，可以回滚到任意版本
- 多台服务器可以从同一个仓库 pull 同一个 image（水平扩展）
- 构建和部署分离，更安全
- 缺点：配置更复杂，需要镜像仓库账号

**适合：** 企业项目、多环境（staging/production）、多台服务器、需要回滚能力

---

#### 对比表

| | 简单版（SSH 直接部署） | 标准版（镜像仓库） |
|---|---|---|
| CI 服务器 | GitHub Actions 免费机器 | GitHub Actions / Jenkins |
| 构建位置 | 生产服务器上 | CI 服务器上 |
| 镜像仓库 | 不需要 | Docker Hub / GHCR / Harbor |
| 回滚 | git revert + 重新 build | 直接 pull 旧版本 image |
| 配置复杂度 | 低（1 个 yml） | 中（yml + 仓库配置） |
| 服务器压力 | 构建时吃资源 | 只跑容器，不构建 |
| 多服务器 | 每台都要 build | 所有服务器 pull 同一个 image |

---

#### 关键概念

- **Jenkins** = 传统的 CI 服务器，需要自己搭建和维护
- **GitHub Actions** = GitHub 自带的 CI 服务器，免费提供构建机器，不用自己搭
- **镜像仓库** = 存放 Docker image 的地方（类似 npm registry 存 npm 包）
  - Docker Hub = 公共镜像仓库（免费）
  - GitHub Container Registry (GHCR) = GitHub 自带的镜像仓库
  - Harbor = 企业自建的私有镜像仓库
- **CI** = Continuous Integration（持续集成）= 代码合并后自动跑测试/构建
- **CD** = Continuous Deployment（持续部署）= 构建通过后自动部署到服务器

#### 当前决策
先用方案二（标准版：GitHub Actions 构建 image → 推到 GHCR → 服务器 pull image）。

#### 实际实施记录

**创建的文件：**
- `.github/workflows/deploy.yml` — GitHub Actions 自动部署配置

**修改的文件：**
- `docker-compose.yml` — app 服务从 `build: .` 改为 `image: ghcr.io/dalles5566/feishuhelper:latest`
- `package.json` — 版本号改为 1.0.0

**GitHub Secrets 配置：**
- `SERVER_HOST` = 服务器 IP
- `SERVER_SSH_KEY` = SSH 私钥（让 GitHub Actions 能 SSH 到服务器）

**遇到的问题：**
- Docker 镜像名必须全小写，但 `${{ github.repository }}` 返回 `Dalles5566/feishuHelper`（有大写）
- 修复：把 tags 直接写死为 `ghcr.io/dalles5566/feishuhelper:latest`

**部署后验证方式：**
- 在服务器上 `docker exec feishuhelper-app-1 cat /app/package.json | grep version` 查看容器内版本号
- 或 `docker inspect ghcr.io/dalles5566/feishuhelper:latest --format='{{.Created}}'` 查看 image 构建时间

**注意事项：**
- 服务器上需要保留 `docker-compose.yml` 和 `.env`，其他代码文件不影响运行
- 第一次部署需要手动 `git pull` 更新 docker-compose.yml，之后全自动
- `docker exec -it feishuhelper-app-1 sh` 可以进入容器内部查看文件

</details>

---

#### Dockerfile 多阶段构建的意义

**问题：为什么 Dockerfile 要分两步（两个 FROM）？**

如果只用一步：
```dockerfile
FROM node:20-alpine
COPY . .
RUN npm ci              # 装所有依赖（包括 devDeps：eslint, vitest, prettier, typescript...）
RUN npx tsc             # 编译 TypeScript → dist/
CMD ["node", "dist/index.js"]
```

最终 image 里包含：
- ❌ TypeScript 源码（运行时不需要）
- ❌ devDependencies（eslint, vitest, prettier, @types/...）
- ❌ tsc 编译器本身
- ✅ dist/（编译后的 JS）
- ✅ 生产依赖

这些多余的东西白白占空间（可能多几百 MB），而且有安全风险（多余的工具可能被利用）。

**分两步（多阶段构建）：**

```dockerfile
# 第一阶段：builder（临时的，用完就丢）
FROM node:20-alpine AS builder
RUN npm ci          # 装所有依赖（需要 tsc 来编译）
RUN npx tsc         # 编译 → 产出 dist/
# 这个阶段结束后，整个环境被丢弃，不会进入最终 image

# 第二阶段：production（最终 image）
FROM node:20-alpine
RUN npm ci --omit=dev           # 只装生产依赖
COPY --from=builder /app/dist ./dist   # 只从 builder 拿 dist
CMD ["node", "dist/index.js"]
```

最终 image 里只有：
- ✅ Node.js 运行时
- ✅ 生产依赖（express, pg, ioredis 等）
- ✅ dist/（编译好的纯 JavaScript）

**类比：** 就像做菜——builder 是厨房（刀、砧板、锅碗瓢盆），production 是上桌的盘子。客人只需要看到成品菜，不需要看到厨房里的工具。

---

#### 依赖分类详解（以我们项目为例）

**什么是"安装依赖"？**
不是 Windows 那种 exe 安装。`npm ci` 只是把一堆 JS 文件从 npm 仓库下载到 `node_modules` 文件夹里。删掉 `node_modules` 就等于"卸载"了。

**生产依赖（dependencies）— 代码运行时需要的**

这些是你代码里 `import` 的东西，app 跑起来时必须有：

| 包名 | 用途 |
|------|------|
| `@langchain/anthropic` | 调 Claude API |
| `@langchain/core` | LangChain 核心（工具、消息类型） |
| `@langchain/openai` | 调 OpenAI API |
| `@larksuiteoapi/node-sdk` | 飞书 REST API 客户端 |
| `bullmq` | 消息队列（后台任务） |
| `fastify` | HTTP 服务器框架 |
| `ioredis` | 连接 Redis |
| `langchain` | LangChain 主包 |
| `pg` | 连接 PostgreSQL |

**开发依赖（devDependencies）— 只在开发/编译时用，运行时不需要**

| 包名 | 用途 | 为什么运行时不需要 |
|------|------|------|
| `typescript` | 把 .ts 编译成 .js | 编译完就不需要了 |
| `tsx` | 开发时直接跑 .ts（不用先编译） | 生产环境跑编译好的 .js |
| `vitest` | 跑测试 | 生产环境不跑测试 |
| `fast-check` | 属性基测试 | 生产环境不跑测试 |
| `eslint` | 检查代码风格 | 生产环境不检查风格 |
| `prettier` | 格式化代码 | 生产环境不格式化 |
| `@types/node` | Node.js 类型定义 | 只给 TypeScript 编译器看 |
| `@types/pg` | pg 的类型定义 | 只给 TypeScript 编译器看 |
| `typescript-eslint` | ESLint 的 TS 插件 | 生产环境不检查 |
| `@eslint/js` | ESLint 核心规则 | 生产环境不检查 |
| `eslint-config-prettier` | ESLint + Prettier 兼容 | 生产环境不检查 |

**Dockerfile 两阶段与依赖的关系：**

```
第一阶段（builder）：
  npm ci = 下载所有依赖（生产 + 开发）到 node_modules/
  ├── pg, ioredis, langchain...（生产依赖 — 编译时需要看到类型）
  └── typescript, eslint, vitest...（开发依赖 — 需要 tsc 来编译）
  
  npx tsc = 用 typescript（开发依赖）把 src/*.ts 编译成 dist/*.js
  
  产出：dist/ 目录（纯 JavaScript，不包含任何 node_modules）
  
  然后整个第一阶段被丢弃 ❌（包括它的 node_modules）

第二阶段（production）：
  npm ci --omit=dev = 只下载生产依赖到新的 node_modules/
  └── pg, ioredis, langchain...（运行时 import 需要的）
  
  COPY --from=builder dist/ = 从第一阶段只拿 dist
  
  最终 image = Node.js + 生产依赖 + dist ✅
```

**为什么第二阶段要重新装生产依赖？**
因为第二阶段是一个全新的干净环境（新的 `FROM node:20-alpine`），第一阶段的 node_modules 已经被丢掉了。`COPY --from=builder` 只拿了 dist，没有拿 node_modules。所以需要重新下载一份（但这次只下载生产依赖，不下载开发依赖）。

---

#### 三个文件的关系和完整流程图

```
你 push 代码到 GitHub
        │
        ▼
┌─────────────────────────────────────────────────────┐
│  GitHub Actions（免费 CI 机器）                        │
│                                                       │
│  读取 .github/workflows/deploy.yml                    │
│  按照里面的步骤执行：                                   │
│                                                       │
│  1. checkout 代码                                     │
│  2. 登录 GHCR（镜像仓库）                              │
│  3. docker build（读 Dockerfile）                     │
│     ┌──────────────────────────────────┐              │
│     │ Dockerfile 第一阶段（builder）     │              │
│     │ npm ci → npx tsc → 产出 dist/    │              │
│     └──────────────┬───────────────────┘              │
│                    │ 只拿 dist                         │
│     ┌──────────────▼───────────────────┐              │
│     │ Dockerfile 第二阶段（production）  │              │
│     │ npm ci --omit=dev + dist → image  │              │
│     └──────────────────────────────────┘              │
│  4. docker push → 把 image 推到 GHCR                  │
│  5. SSH 到服务器 → docker compose pull → 重启          │
└─────────────────────────────────────────────────────┘
        │
        ▼
┌─────────────────────────────────────────────────────┐
│  GHCR（GitHub Container Registry = 镜像仓库）         │
│                                                       │
│  存放构建好的 image（ghcr.io/dalles5566/feishuhelper） │
│  服务器从这里 pull                                     │
└─────────────────────────────────────────────────────┘
        │
        ▼
┌─────────────────────────────────────────────────────┐
│  你的 DigitalOcean 服务器                              │
│                                                       │
│  docker compose pull app → 从 GHCR 拉最新 image       │
│  docker compose up -d → 用新 image 替换旧容器          │
│                                                       │
│  docker-compose.yml 定义：                             │
│  - app 容器（用 GHCR 上的 image）                      │
│  - postgres 容器（用 Docker Hub 的 postgres:16）       │
│  - redis 容器（用 Docker Hub 的 redis:7）              │
└─────────────────────────────────────────────────────┘
```

---

#### deploy.yml 逐行解释

```yaml
name: Build and Deploy
# ↑ 这个 workflow 的名字，在 GitHub Actions 页面显示用的

on:
  push:
    branches: [main]
# ↑ 触发条件：当有代码 push 到 main 分支时，自动执行这个 workflow

env:
  REGISTRY: ghcr.io
  IMAGE_NAME: ${{ github.repository }}
# ↑ 定义变量：
#   REGISTRY = 镜像仓库地址（GitHub Container Registry）
#   IMAGE_NAME = 镜像名字（自动取你的 GitHub 用户名/仓库名）

jobs:
  build-and-deploy:
    runs-on: ubuntu-latest
# ↑ 在 GitHub 提供的 Ubuntu 机器上执行

    permissions:
      contents: read      # 允许读代码
      packages: write     # 允许推 image 到 GHCR
# ↑ 权限设置：这个 job 能做什么

    steps:
      - name: Checkout code
        uses: actions/checkout@v4
# ↑ 第一步：把你的代码从 GitHub 拉到 CI 机器上
#   （CI 机器是空的，需要先拿到代码才能 build）

      - name: Log in to GitHub Container Registry
        uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
# ↑ 第二步：登录镜像仓库
#   就像你要往 npm 发包需要先 npm login 一样
#   GITHUB_TOKEN 是 GitHub 自动提供的，不需要你手动配

      - name: Build and push Docker image
        uses: docker/build-push-action@v5
        with:
          context: .
          push: true
          tags: ghcr.io/dalles5566/feishuhelper:latest
# ↑ 第三步：构建 image 并推到 GHCR
#   context: . = 在当前目录找 Dockerfile
#   push: true = 构建完自动推到仓库
#   tags = image 的名字和版本（latest = 最新版）
#   这一步内部执行的就是 Dockerfile 里的两个阶段

      - name: Deploy to server
        uses: appleboy/ssh-action@v1
        with:
          host: ${{ secrets.SERVER_HOST }}
          username: root
          key: ${{ secrets.SERVER_SSH_KEY }}
          script: |
            cd ~/feishuHelper
            docker compose pull app
            docker compose up -d
# ↑ 第四步：SSH 到你的服务器执行命令
#   host = 服务器 IP（从 GitHub Secrets 读取，不硬编码）
#   key = SSH 私钥（从 GitHub Secrets 读取）
#   script = 在服务器上执行的命令：
#     cd ~/feishuHelper → 进入项目目录
#     docker compose pull app → 从 GHCR 拉最新 image
#     docker compose up -d → 用新 image 重启 app 容器
```

---

#### docker-compose.yml 逐行解释

```yaml
services:
# ↑ 定义这个"沙盒"里有哪些服务

  app:
    image: ghcr.io/dalles5566/feishuhelper:latest
# ↑ app 服务用 GHCR 上的 image（不再本地 build）
#   之前是 build: .（本地构建），现在改成从仓库拉现成的

    ports:
      - "3000:3000"
# ↑ 把容器内的 3000 端口映射到服务器的 3000 端口
#   左边是服务器端口，右边是容器内端口

    env_file:
      - .env
# ↑ 读取 .env 文件里的环境变量（API key、密码等）

    environment:
      DB_HOST: postgres
      REDIS_HOST: redis
# ↑ 覆盖 .env 里的 DB_HOST 和 REDIS_HOST
#   因为在 Docker 网络里，要用服务名（postgres/redis）而不是 localhost

    depends_on:
      - postgres
      - redis
# ↑ app 依赖 postgres 和 redis，Docker 会先启动它们

    restart: unless-stopped
# ↑ 容器挂了自动重启（除非你手动 stop）

  postgres:
    image: postgres:16
# ↑ 从 Docker Hub 拉 PostgreSQL 16 官方镜像

    environment:
      POSTGRES_DB: feishu_helper
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: localpassword
# ↑ 第一次启动时，postgres 看到这些变量会自动：
#   1. 创建一个叫 feishu_helper 的数据库
#   2. 设置用户名和密码

    ports:
      - "5432:5432"
# ↑ 映射端口，让你可以从外部（如 TablePlus）连接

    volumes:
      - pgdata:/var/lib/postgresql/data
# ↑ 数据持久化：数据库文件存在 Docker volume 里
#   容器重启/删除，数据不丢

      - ./migrations/schema.sql:/docker-entrypoint-initdb.d/schema.sql
# ↑ 初始化脚本：第一次启动时自动执行 schema.sql（建表 + seed data）
#   只在 pgdata 为空时执行一次，之后重启不会重复执行

    restart: unless-stopped

  redis:
    image: redis:7
# ↑ 从 Docker Hub 拉 Redis 7 官方镜像，直接跑，不需要配置

    ports:
      - "6379:6379"
    restart: unless-stopped

volumes:
  pgdata:
# ↑ 声明一个叫 pgdata 的 Docker volume（数据持久化用的）
```

---

#### Dockerfile 逐行解释

```dockerfile
# ===== 第一阶段：builder（临时的，构建完就丢） =====
FROM node:20-alpine AS builder
# ↑ 基础镜像：带 Node.js 20 的精简 Linux（alpine = 体积小）
#   AS builder = 给这个阶段起名叫 builder，后面引用用

WORKDIR /app
# ↑ 设置工作目录（相当于 cd /app）

COPY package.json package-lock.json ./
# ↑ 先只复制 package 文件（利用 Docker 缓存：依赖没变就不重新装）

RUN npm ci
# ↑ 安装所有依赖（包括 devDeps：typescript, eslint, vitest...）
#   npm ci = 严格按 lock 文件装，比 npm install 更快更可靠

COPY tsconfig.json ./
COPY src/ ./src/
# ↑ 复制 TypeScript 配置和源代码

RUN npx tsc
# ↑ 编译 TypeScript → JavaScript，产出到 dist/ 目录
#   到这里，builder 阶段的任务完成了

# ===== 第二阶段：production（最终 image） =====
FROM node:20-alpine
# ↑ 重新开始一个干净的 Node.js 环境（之前的 builder 全部丢弃）

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev
# ↑ 只装生产依赖（不装 typescript, eslint, vitest 等 devDeps）

COPY --from=builder /app/dist ./dist
# ↑ 从 builder 阶段只拿 dist 目录（编译好的 JS）
#   这就是"提纯"——只要成品，不要工具

COPY migrations/ ./migrations/
# ↑ 复制数据库迁移文件（schema.sql）

ENV NODE_ENV=production
# ↑ 设置环境变量为生产模式

EXPOSE 3000
# ↑ 声明容器监听 3000 端口（文档作用，实际映射靠 docker-compose）

CMD ["node", "dist/index.js"]
# ↑ 容器启动时执行的命令：用 Node.js 跑编译后的入口文件
```

</details>

---

## 2026-05-19 (Tuesday)

### ✅ Docker 化部署 + 服务器上线
**Summary:** 将 feishuHelper 项目 Docker 化，创建 Dockerfile 和 docker-compose.yml，成功部署到 DigitalOcean 服务器，飞书机器人现在 7×24 运行。

<details>
<summary>
<strong>📖 Click to expand full details</strong>
</summary>

**Component/File:** `Dockerfile`, `docker-compose.yml`, `.dockerignore`, `migrations/schema.sql`

#### 完成内容

**Docker 化：**
- 创建 `Dockerfile`：多阶段构建（builder 编译 TypeScript → production 只保留编译产物和生产依赖）
- 创建 `docker-compose.yml`：定义三个服务（app、postgres:16、redis:7），统一 Docker 网络
- 创建 `.dockerignore`：排除 node_modules、dist、.env 等不需要进镜像的文件
- 在 `migrations/schema.sql` 添加 seed data（默认员工数据，`ON CONFLICT DO NOTHING` 防重复）

**服务器部署：**
- 创建 DigitalOcean Droplet：Ubuntu 24.04 LTS，1 vCPU / 2GB RAM / 50GB SSD
- 配置 SSH Key 认证（ed25519，无 passphrase）
- 服务器安装 Docker，clone 代码，配置 .env
- `docker compose up -d` 一键启动，三个容器全部运行正常
- 飞书机器人已由服务器 7×24 接管

#### Key Learnings

1. **Docker 核心概念：**
   - 镜像（image）= 预打包的软件安装包，从 Docker Hub 下载
   - 容器（container）= 镜像跑起来的实例，在沙盒里运行
   - docker-compose = 一次管理多个容器的工具
   - `docker compose up -d --build` = 重新构建镜像 + 后台启动

2. **Dockerfile 是把代码打包成镜像的"配方"**
   - `FROM node:20-alpine` = 基础镜像（带 Node.js 的精简 Linux）
   - 多阶段构建：builder 阶段装所有依赖 + 编译，production 阶段只保留生产依赖 + 编译产物

3. **docker-compose.yml 的工作原理：**
   - `image: postgres:16` = 从 Docker Hub 拉取官方镜像
   - `build: .` = 根据本地 Dockerfile 构建镜像
   - `environment` = 设置环境变量（postgres 用它创建数据库）
   - `volumes` = 数据持久化 + 初始化脚本映射
   - `/docker-entrypoint-initdb.d/` = postgres 第一次启动时自动执行里面的 .sql 文件

4. **SSH Key 认证：**
   - 私钥在本地（钥匙），公钥在服务器（锁）
   - 没有私钥就连不上，比密码安全
   - "无 passphrase" 不是没有认证，是私钥文件本身没加密

5. **部署注意事项：**
   - 本地 Docker 和服务器 Docker 的数据库完全独立，即使端口一样
   - 不能同时跑两个 app 实例连同一个飞书 APP_ID，消息会乱
   - 只改了文档不需要重新构建 Docker，只有改了 src/ 代码才需要 `--build`

6. **更新流程：** 本地改代码 → git push → 服务器 git pull → `docker compose up -d --build`

#### Files Modified
- `Dockerfile` — 多阶段构建配方
- `docker-compose.yml` — 三服务编排
- `.dockerignore` — 构建排除列表
- `migrations/schema.sql` — 添加 seed data

</details>

---

## 2026-05-13 (Wednesday)

### ✅ Page User Manual — Spec 全部完成 (Task 1-10)
**Summary:** 完成了 page-user-manual spec 的所有核心任务，包括 routeToDocPath 工具函数、HelpLink 浮动按钮、VitePress 文档站、65 个手册文件、Kiro Hook、集成验证。修复了路径映射和端口问题，帮助按钮能正确跳转到对应文档页面。

<details>
<summary>
<strong>📖 Click to expand full details</strong>
</summary>


**Component/File:** `src/utils/docPath.ts`, `src/components/HelpLink/index.tsx`, `docs/user-manual/`

#### Problem Encountered
1. HelpLink 生成 `demo-position` 而非 `position` — 实际 URL `/demo/position` 中 `demo` 是项目名被当成静态段
2. 扁平化 md 文件冗余 — `routeToDocPath` 输出 `device-tag`，但文件在 `device/tagListUserManual.md`
3. rsmap 私有包装不上 — 来自 `nexus.reliablesense.com`，需要公司 VPN
4. Node 24 + webpack OpenSSL 报错
5. 开发时 admin（8000）和 VitePress（5173）端口不同，帮助按钮跳转 404

#### Root Cause Analysis
1. `location.pathname` 包含项目名前缀，`routeToDocPath` 无法区分项目名和静态路径段
2. 文件命名不规律（List/Detail/UserManual），无法纯自动化转换
3. yarn.lock 里记录的 resolved URL 指向公司私有 nexus，本地网络访问不到
4. 项目用的 webpack 版本不兼容 Node 17+ 的 OpenSSL
5. HelpLink 默认 baseUrl 是 `/docs`（同端口），但 VitePress 跑在另一个端口

#### Solution Implemented
1. HelpLink 去掉 URL 第一段项目名，`NON_PROJECT_PATHS` 列表排除 `login`/`register`/`user`/`project`/`company`
2. 用 `ROUTE_DOC_MAP` 映射表（30+ 条目）替代扁平化，保留原有子目录结构
3. Surge 连公司 VPN 后 `yarn install`
4. `NODE_OPTIONS=--openssl-legacy-provider` 启动
5. `config/config.dev.ts` 添加 `process.env.DOCS_BASE_URL: 'http://localhost:5173/docs'`，`docs:dev` 固定端口 5173

#### Key Learnings
1. **VitePress 是 md → HTML 生成器** — 开发时需要两个终端，生产环境构建成静态文件放进 Nginx 的 `/docs/` 路径
2. **Kiro Hook 不支持 git commit 事件** — 用 `userTriggered` 手动触发更合适，在 Hooks 面板点运行按钮
3. **路由映射不能纯自动化** — 文件命名不规律，需要手动映射表
4. **yarn.lock 被改会导致依赖解析失败** — 加新依赖后要一起提交 yarn.lock
5. **Nginx 不是打包工具** — 它是 web 服务器，负责把静态文件返回给浏览器；打包是 webpack/umi 做的事

#### Files Modified
- `src/utils/docPath.ts` — 工具函数 + ROUTE_DOC_MAP 映射表
- `src/components/HelpLink/index.tsx` + `index.less` — 浮动帮助按钮组件
- `src/app.tsx` — childrenRender 注入 HelpLink
- `config/config.dev.ts` — DOCS_BASE_URL 开发环境配置
- `docs/user-manual/.vitepress/config.js` — VitePress 配置 + sidebar
- `docs/user-manual/index.md` — 总目录
- `docs/user-manual/**/*.md` — 65 个手册文件
- `.kiro/hooks/update-user-manual.kiro.hook` — 手动触发更新手册 hook
- `.kiro/hooks/README.md` — hooks 使用说明
- `package.json` — vitepress 依赖 + docs:dev/docs:build 脚本


</details>
---


## 2026-05-09 (Saturday)

### ✅ Feishu Helper - Task 8 Checkpoint: Architecture Review
**Summary:** Completed Tasks 1-8 of the Feishu Helper project. Reviewed and understood the full architecture: webhook gateway → AI agent → services (meeting analyzer, task manager, task assignment) → workflow engine → state machine → database.

<details>
<summary>
<strong>📖 Click to expand full details</strong>
</summary>

**Project:** Feishu Helper (飞书工作流自动化工具)

#### Architecture Overview

**基础设施 (Infrastructure)**
- migrations — 创建数据库表格
- config/database.ts — 连接数据库的 pool
- config/index.ts — 读 .env，其他模块通过它获取配置
- models/ — 对象的 interface 定义（形状约定）
- errors.ts — throw exception 用的，分了 5 类，让 retry 知道哪些能重试
- retry.ts — 把 try/catch 包进去，失败自动重试，不用每次自己写
- db.ts — 操控数据库的 CRUD 工具

**飞书集成 (Feishu Integration)**
- webhookGateway — 接收飞书请求，验签，根据 event_type 分发给对应 handler（handler 必须先注册）
- feishuAuth — 拿 token 的，是 feishuMcp 的"钥匙"
- feishuMcp — Agent 的工具包，带着 token 调飞书 API

**AI 核心 (AI Core)**
- AgentCore — 大脑。接收消息 → 发给 LLM → LLM 决定调什么工具 → 执行工具 → 结果反馈给 LLM → 循环直到最终回复
- MeetingAnalyzer — 分析会议内容，长的分片再合并，提取行动项/决策/摘要

**任务管理 (Task Management)**
- TaskManager — 调 feishuMcp 在飞书创建任务 + 写本地数据库 + 调 stateMachine 改状态
- TaskAssignment — 管 task_assignments 表，记录谁在做什么（active/reassigned/completed）
- stateMachine — 验证状态转换合不合规，改 tasks 表的 state 字段
- workflowEngine — 接收业务事件（"开发完成了"），自动翻译成目标状态，调 stateMachine

#### Key Learnings

1. **EventDispatcher pattern** — 主管(dispatcher) + 员工(handler) + 登记(register) + 顾客(event)
2. **Token management** — 提前5分钟刷新避免窗口期，并发去重避免打爆API
3. **LLM vs MCP tools** — LLM是大脑（思考），MCP工具是手脚（操作飞书）
4. **State machine vs workflow engine** — stateMachine验证合规性，workflowEngine翻译业务事件
5. **taskManager vs workflowEngine** — 都能改状态，入口不同：一个直接指定，一个事件驱动
6. **本地数据库是真相来源，飞书是展示层**
7. **所有模块现在是独立零件，Task 14才串联**

#### Progress
- 310 tests passing across 14 test files
- Tasks 1-8 complete (infrastructure, types, state machine, workflow engine, webhook gateway, feishu auth/MCP, AI agent, meeting analyzer, task manager, task assignment)
- Remaining: code verifier, doc generator, QA feedback, message queue, end-to-end integration

</details>

---


## 2026-05-04 (Monday)

### ✅ Fixed GeojsonEditor - Grey Midpoint Handles Missing After Refactoring
**Summary:** After refactoring GeojsonEditor from class to functional component, the grey midpoint handles (for selecting/moving polygon edges) disappeared. Root cause was the `mode` prop (a class instance) changing reference on every render, causing `_updateLayer` to recreate the `EditableGeoJsonLayer` repeatedly and destroy its internal state.

<details>
<summary>
<strong>📖 Click to expand full details</strong>
</summary>

**Component:** `src/components/GeojsonEditor/index.tsx`

#### Problem Encountered
- Grey midpoint handles on polygon edges were missing
- Could not select or interact with the polygon edges
- Red corner dots were visible but non-interactive
- `EditableGeoJsonLayer` was being created correctly (confirmed via console.log)

#### Root Cause
The `mode` prop is a class instance (e.g., `CompositeMode`, `ViewMode`). In the useEffect dependency array, using `mode` directly compares by reference. Every time the parent re-renders, a new `mode` object is created with the same configuration but a different reference. This triggered the useEffect, which called `setFeaturesState`, which triggered `_updateLayer`, which recreated the `EditableGeoJsonLayer` — destroying its internal state (edit handles, guides, midpoint handles).

The layer was being created **4 times** on mount instead of once.

#### Investigation Steps

1. **Confirmed layer type was correct** — `EditableGeoJsonLayer` with `CompositeMode`, `selectedFeatureIndexes: [0]`, `featuresState` had data
2. **Counted `_updateLayer` calls** — 4 times on mount (should be 1)
3. **Removed all dependencies** — only `[featuresState]` → fixed! Grey handles appeared
4. **Added dependencies back one by one** — found `mode` was the culprit
5. **Root cause** — `mode` is a class instance, reference changes every render

#### Solution

Serialize `mode` for comparison instead of comparing by reference:

```typescript
// Before (compares reference - changes every render):
mode,

// After (compares value - stable across renders):
typeof mode === 'string' ? mode : JSON.stringify(mode),
```

Also added `JSON.stringify()` to all object/array dependencies that were missing it:
- `data`, `selectedFeatureIndexes`, `spaceState`, `modeConfig`, `guides`
- `highlightColor`, `coordinateOrigin`, `modelMatrix`, `extensions`
- `updateTriggers`, `loaders`, `loadOptions`, `parameters`, `transitions`

#### Key Learnings

1. **Class instances as useEffect dependencies** — Class instances (like deck.gl modes) change reference on every render even if their configuration is the same. Use `JSON.stringify()` or `constructor.name` to compare by value.

2. **`EditableGeoJsonLayer` maintains internal state** — Unlike regular layers, `EditableGeoJsonLayer` has internal state for edit handles, guides, and interaction. Recreating it destroys this state. Minimize how often `_updateLayer` is called for this component.

3. **Always `JSON.stringify()` objects/arrays in dependencies** — Plain objects and arrays in useEffect dependencies compare by reference, not value. This causes unnecessary re-triggers when the parent re-renders.

4. **Debug by counting** — Counting how many times `_updateLayer` is called reveals if the issue is excessive re-creation vs wrong configuration.

#### Files Modified
- `src/components/GeojsonEditor/index.tsx` — Fixed `mode` dependency serialization, added `JSON.stringify()` to object/array dependencies

</details>

---


### ✅ Fixed Line Layer Not Removing on Floor Switch - Found Real Root Cause
**Summary:** Found the real root cause of why line layers persisted when switching floors. The lodash debounce trailing timer was firing after unmount and recreating the layer. Fixed by cancelling debounce timers in the cleanup function.

<details>
<summary>
<strong>📖 Click to expand full details</strong>
</summary>

**Component:** `src/components/Line/index.tsx`

#### Problem Encountered
When switching floors, the line layer was never removed from the map even though `removeLayer()` was called and sent empty layers to the Wrapper.

#### Investigation Steps

**1. Added layer ID logging to Wrapper's throttled setLayersState:**
- Confirmed the line layer ID (`line-9`, `line-9-arrow`) was never removed from the final layer list

**2. Tried `flush()` approach in Wrapper:**
- Called `cancel()` then `flush()` on the throttle when removing a layer
- Didn't work because the problem wasn't the throttle timing

**3. Tried `removedLayerIdsRef` approach in Wrapper:**
- Tracked recently removed IDs and ignored updates for them
- Worked but was a workaround, not the real fix

**4. Added `console.trace()` to find the caller:**
- Added trace when `_updateLayer` was called after `isUnmountRef` was true
- **Found it:** The call came from `updateLayerDebounceTrailing` → lodash debounce's internal `setTimeout`

#### Root Cause
The lodash `debounce` trailing function had a 500ms timer that was scheduled before the component unmounted. When the component unmounted:

1. `removeLayer()` runs → layer removed from cache ✅
2. 500ms later → debounce trailing timer fires → calls `_updateLayer()` → layer added back ❌

The debounce timers were **not being cancelled** on unmount.

#### Solution

Cancel both debounce timers in the cleanup function:

```typescript
useEffect(() => {
  _updateLayer();
  return () => {
    isUnmountRef.current = true;
    clearTimeout(timeoutRef.current);
    updateLayerDebounceLeading.cancel();   // ← THE FIX
    updateLayerDebounceTrailing.cancel();   // ← THE FIX
    removeLayer();
  };
}, []);
```

#### Why Previous Fixes Seemed to Work

- **`isUnmountRef` check in `_updateLayer()`**: Worked because it caught the debounce callback and prevented it from recreating the layer. But it was treating the symptom, not the cause.
- **Wrapper `removedLayerIdsRef`**: Worked because it rejected the late update at the Wrapper level. Also treating the symptom.
- **The real fix**: Cancel the debounce timers so they never fire after unmount. No late callback = no layer recreation.

#### Key Learnings

1. **Always cancel debounce/throttle timers on unmount** - Lodash debounce uses internal setTimeout. These timers survive component unmount and will fire their callbacks even after cleanup runs.

2. **Use `console.trace()` to find the real caller** - Instead of guessing which useEffect or function is calling `_updateLayer()`, the stack trace immediately showed it was the debounce trailing timer.

3. **Compare with working components** - The Model component worked because its `_updateLayer` is async (uses `getData().then()`). By the time the async callback runs, `isUnmountRef` is already true. Line's `_updateLayer` is synchronous, so the debounce callback executes immediately.

4. **Fix the cause, not the symptom** - `isUnmountRef` and `removedLayerIdsRef` were workarounds. Cancelling the debounce timers is the proper fix that prevents the problem at its source.

#### Also Fixed: Wrapper Infinite Re-render Loop
- **Problem:** Wrapper kept re-rendering infinitely after refactoring to functional component
- **Cause:** `_updateLayer` function was recreated on every render, causing children to see new prop references and re-render
- **Fix:** Wrapped `_updateLayer` in `useRef` for a stable reference: `const updateLayer = useRef((layer) => { ... }).current`

#### Files Modified
- `src/components/Line/index.tsx` - Added `updateLayerDebounceLeading.cancel()` and `updateLayerDebounceTrailing.cancel()` to cleanup
- `src/modules/Wrapper/index.tsx` - Wrapped `_updateLayer` in `useRef` for stable reference

#### Status
✅ Fixed - Line layers properly removed when switching floors
✅ Fixed - Wrapper no longer re-renders infinitely

</details>

---


## 2026-05-01 (Thursday)

### ✅ Fixed Wrapper Infinite Re-render Loop
**Summary:** Fixed infinite re-render loop in refactored Wrapper component. Root cause was `_updateLayer` function being recreated on every render, causing children to see new prop references and re-render endlessly. Fixed by wrapping `_updateLayer` in `useRef`.

<details>
<summary>
<strong>📖 Click to expand full details</strong>
</summary>

**Component:** `src/modules/Wrapper/index.tsx`

#### Problem Encountered
After refactoring Wrapper from class to functional component, the Wrapper kept re-rendering infinitely, causing all child components (Line, Marker, etc.) to continuously call `updateLayer`.

#### Root Cause Analysis
In a class component, methods like `this.updateLayer` are stable references - they never change between renders. In a functional component, every function is recreated on every render.

The `renderChildren` function passes `_updateLayer` as a prop to all children. Every render:
1. New `_updateLayer` function created → children see new prop reference
2. Children re-render → children call `_updateLayer`
3. `_updateLayer` calls throttled `setLayersState` → Wrapper re-renders
4. Back to step 1 → infinite loop

#### Investigation Steps

1. **Removed `useEffect([widthState, heightState])`** - Thought the width/height watcher was causing extra renders. Didn't fix it.
2. **Moved `effects` to `useRef`** - Thought new LightingEffect objects on every render caused DeckGL to re-render. Didn't fix it.
3. **Moved `views` array to constant** - Same idea. Didn't fix it.
4. **Wrapped `_updateLayer` in `useRef`** - Made the function reference stable across renders. ✅ Fixed!

#### Solution Implemented

```typescript
// Before (new function every render - causes loop):
const _updateLayer = (layer: any): void => {
  // ... update logic
};

// After (stable reference - no loop):
const _updateLayer = useRef((layer: any): void => {
  // ... update logic
}).current;
```

#### Key Learnings

1. **Functions passed as props must be stable in functional components** - In class components, `this.method` is always the same reference. In functional components, functions are recreated every render. Use `useRef` or `useCallback` to stabilize them.

2. **Infinite re-render loops in functional components** are often caused by:
   - Functions recreated every render passed as props
   - State updates triggered by prop changes that cause more prop changes
   - Missing dependency arrays on useEffect

3. **`useRef` vs `useCallback` for stable functions:**
   - `useRef((fn) => {}).current` - function never changes, always uses refs for latest values
   - `useCallback(fn, [deps])` - function changes when deps change
   - For functions that only use refs internally, `useRef` is simpler

#### Files Modified
- `src/modules/Wrapper/index.tsx` - Wrapped `_updateLayer` in `useRef` for stable reference

#### Status
✅ Fixed - Wrapper no longer re-renders infinitely

</details>

---

### 🔍 Investigated Line Component Mount/Unmount Behavior
**Summary:** Investigated why Line component unmounts and remounts on page load. Found this is pre-existing behavior from the parent component, not introduced by refactoring. Both original class and refactored functional components show the same pattern.

<details>
<summary>
<strong>📖 Click to expand full details</strong>
</summary>

**Component:** `src/components/Line/index.tsx`, `src/components/Line/LineOriginalIndex.tsx`

#### Investigation
- Added console.logs to both original and refactored Line components
- Both show: mount → unmount → mount sequence on page load
- The parent component (modules/Line or Wrapper) causes this by re-rendering during initialization
- Component IDs change between mount cycles (line-6 → line-9), confirming full unmount/remount

#### Key Finding
The `removeLayer()` call during unmount cleanup doesn't actually remove the layer from the map due to the Wrapper's throttled `updateLayerThrottle` (300ms, leading: false). The `_updateLayer()` from the third useEffect runs after cleanup and overwrites the empty cache entry before the throttle fires.

This is why `isUnmountRef` is essential - it prevents `_updateLayer()` from recreating layers after the component has unmounted.

#### Files Modified
- `src/components/Line/LineOriginalIndex.tsx` - Added console.logs for comparison (temporary)

</details>

---


## 2026-04-30 (Thursday)

### ✅ Fixed Line Component Floor Switching Bug (Also Fixed MultiFloorLine)
**Summary:** Fixed bug where old floor lines remained visible when switching floors. Root cause was missing `isUnmountRef` flag - unmounting components were still updating layers. This also fixed the MultiFloorLine extra lines bug.

<details>
<summary>
<strong>📖 Click to expand full details</strong>
</summary>


**Component:** `src/components/Line/index.tsx`

#### Problem Encountered
After refactoring Line component from class to functional component, when switching floors:
- Old floor's lines remained visible on the map
- Lines accumulated instead of being replaced
- MultiFloorLine showed extra lines from other floors

**Symptoms:**
- Switch to floor 1: floor 1 lines show ✓
- Switch to floor 2: floor 1 lines + floor 2 lines show ✗
- Switch to floor 3: all 3 floors' lines visible ✗

#### Root Cause Analysis
The refactored Line component was missing the `isUnmount` flag from the original class component. When a Line component unmounted (e.g., when switching floors), pending useEffect calls or debounced functions would still try to call `_updateLayer()`, causing old layers to persist on the map.

**Why this happened:**
1. User switches from floor 1 to floor 2
2. Floor 1's Line component starts unmounting
3. React cleanup function runs, calls `removeLayer()`
4. BUT: pending useEffect or debounced zoom calls still execute
5. These calls run `_updateLayer()` which recreates the floor 1 layer
6. Floor 1 layer persists even though component is unmounted

#### Investigation Steps

**1. Tested dependency-based useEffect approach:**
- Listed all props as dependencies with proper serialization (`JSON.stringify`, `.toString()`)
- Result: Still had floor switching issues

**2. Tried adding `removeLayer()` before `_updateLayer()`:**
- Called `removeLayer()` then `_updateLayer()` in useEffect
- Result: Didn't fix the issue - layers still accumulated

**3. Switched to `compareProps` pattern:**
- Used `cachedPropsRef` to store previous props
- Compared with `compareProps`, `compareSpaceState`, `isEqual`
- Matched original `componentDidUpdate` logic
- Result: Better, but still had issues with unmounting components

**4. Added `isUnmountRef` flag (THE FIX):**
- Added `isUnmountRef` to track unmount state
- Set to `true` in cleanup function
- Check in `_updateLayer()` to prevent updates after unmount
- Result: ✅ Fixed! Lines properly clean up when switching floors

#### Solution Implemented

**Added the `isUnmount` pattern from the original class component:**

```typescript
// 1. Add ref to track unmount state
const isUnmountRef = useRef<boolean>(false);

// 2. Set flag when unmounting
useEffect(() => {
  _updateLayer();
  return () => {
    isUnmountRef.current = true;  // Mark as unmounted
    clearTimeout(timeoutRef.current);
    removeLayer();
  };
}, []);

// 3. Check flag in _updateLayer to prevent updates after unmount
const _updateLayer = (withoutArrow = false) => {
  if (isUnmountRef.current) {
    removeLayer();  // Clean up if unmounted
    return;         // Exit early, don't create layers
  }
  // ... rest of update logic (create PathLayer, IconLayer, etc.)
};
```

**Also kept the props comparison pattern:**

```typescript
const cachedPropsRef = useRef<LineProps>(props);

useEffect(() => {
  const prevProps = cachedPropsRef.current;
  
  if (!compareProps(prevProps, props)) {
    _updateLayer();
  }
  if (!compareSpaceState(prevProps.spaceState, props.spaceState)) {
    _updateLayer();
  }
  if (!isEqual(prevProps.show3Dimension, props.show3Dimension)) {
    _updateLayer();
  }
  if (!isEqual(prevProps.showArrow, props.showArrow)) {
    _updateLayer();
  }
  
  cachedPropsRef.current = props;
});
```

This matches the original `componentDidUpdate` logic more accurately than dependency arrays.

#### Why This Works

**The `isUnmountRef` flag prevents post-unmount updates:**

1. **When component is mounted:**
   - `isUnmountRef.current = false`
   - `_updateLayer()` runs normally, creates/updates layers

2. **When component unmounts:**
   - Cleanup function runs: `isUnmountRef.current = true`
   - Calls `removeLayer()` to clean up

3. **If any pending calls try to run after unmount:**
   - Debounced zoom functions might still fire
   - useEffect might trigger one last time
   - The check `if (isUnmountRef.current)` catches it
   - Calls `removeLayer()` to ensure cleanup
   - Returns early, preventing any layer creation

**This is a common React pattern to prevent:**
- Memory leaks
- Operations on unmounted components
- Stale layer updates

#### Bonus Fix: MultiFloorLine Extra Lines Bug

This fix also resolved the MultiFloorLine extra lines bug! The MultiFloorLine issue was caused by the same problem in the base Line component.

**How MultiFloorLine works:**
- Creates multiple Line components, one for each floor's path segments
- When you switch floors, old floor's Line components should unmount
- New floor's Line components should mount

**Why it was broken:**
- Old floor's Line components were unmounting
- But their pending updates were still running
- This caused old floor lines to persist on the map

**Why the fix works:**
- Now when a Line component unmounts, `isUnmountRef` is set to true
- Any pending updates check this flag and just call `removeLayer()`
- Old floor lines are properly cleaned up
- Only current floor's lines are displayed

#### Key Learnings

1. **Always implement cleanup flags for async operations** - If a component has debounced functions, timers, or async operations, use a ref to track unmount state and check it before performing operations.

2. **Functional component lifecycle is different from class components:**
   - Class: `componentWillUnmount` runs, then no more methods can be called
   - Functional: Cleanup runs, but pending useEffect/callbacks can still fire
   - Need explicit flag to prevent post-unmount operations

3. **Props comparison pattern vs dependency arrays:**
   - Dependency arrays: Simple but can trigger too often with complex props
   - Comparison pattern: More control, matches class component behavior exactly
   - Use comparison functions (`compareProps`, `compareSpaceState`) that handle function comparisons and exclude certain props

4. **Debugging unmount issues:**
   - Add console.logs to track mount/unmount lifecycle
   - Check if operations are running after unmount
   - Look for debounced functions or async operations that might fire late
   - Compare with original class component's cleanup logic

5. **One fix can solve multiple bugs** - The MultiFloorLine bug seemed like a separate issue, but it was actually caused by the same root problem in the base Line component. Always look for shared dependencies when debugging.

6. **The `isUnmount` pattern is critical for layer-based components:**
   - Deck.gl layers persist until explicitly removed
   - If a component unmounts but still calls `updateLayer()`, old layers remain
   - Always check unmount state before updating layers

#### Files Modified
- `src/components/Line/index.tsx` - Added `isUnmountRef` flag and `compareProps` pattern

#### Status
✅ Fixed - Lines now properly clean up when switching floors
✅ MultiFloorLine extra lines bug also resolved
✅ Component properly prevents post-unmount layer updates



</details>

---

## 2026-04-29 (Wednesday)

### ✅ Refactored Line Component - Fixed Arrow Disappearing Bug
**Summary:** Converted Line component from class to functional. Fixed bug where arrows disappeared during zoom by splitting useEffects and using updateLayerRef pattern to avoid stale closures.

<details>
<summary>
<strong>📖 Click to expand full details</strong>
</summary>


**Component:** `src/components/Line/index.tsx`

#### Problem Encountered
After refactoring the Line component from class to functional component, arrows disappeared when zooming in/out on the map.

#### Root Cause Analysis
1. **Single useEffect issue**: The componentDidUpdate useEffect had all props AND zoom in dependencies, and always called `_updateLayer()` at the end. This meant zoom changes triggered immediate (non-debounced) updates, causing arrows to disappear during zoom animation.

2. **Stale closure issue**: Debounce functions created with `useRef().current` captured the initial `_updateLayer` function. On subsequent renders, `_updateLayer` was redefined with new props/context, but debounce functions still called the old version with stale data (wrong zoom values), causing step calculation errors.

#### Solution Implemented

**1. Split into three separate useEffects:**
- Mount/unmount effect (empty deps `[]`) - calls `_updateLayer()` once on mount
- Zoom tracking effect (only `context.viewport.zoom` dep) - calls debounce functions when zoom floor changes
- Props change effect (all props deps) - calls `_updateLayer()` directly when props change

**2. Use `updateLayerRef` pattern:**
```javascript
const updateLayerRef = useRef(null);

const _updateLayer = (withoutArrow = false) => { /* ... */ };

// Store latest _updateLayer in ref
updateLayerRef.current = _updateLayer;

// Debounce functions call the ref
const updateLayerDebounceLeading = useRef(
  debounce(() => {
    updateLayerRef.current?.(true);  // Always calls latest version
  }, 500, { leading: true, trailing: false })
).current;
```

**3. Proper dependency comparisons:**
- `JSON.stringify()` for objects/arrays (compare by value)
- `.toString()` for functions (compare by implementation)
- Direct values for primitives

#### Key Learnings

1. **Debounce functions need `useRef`** to preserve their internal state (timers, pending calls) across renders. Without it, they get recreated on every render and lose their debouncing behavior.

2. **Functions that reference other functions need the ref pattern** to avoid stale closures. The `updateLayerRef.current` pattern ensures debounce functions always call the latest version of `_updateLayer` with current props/context.

3. **Separate concerns into separate useEffects** for clearer logic and better control. Don't mix zoom tracking and props changes in the same effect.

4. **Match the original class component behavior exactly**: 
   - Props changes → immediate `updateLayer()` call
   - Zoom floor changes → debounced `updateLayer()` calls (to avoid rendering arrows during zoom animation)

5. **Understanding closure in React functional components**: Functions defined inside the component capture props/state at render time. If you need a function to always use the latest values, store it in a ref.

#### Files Modified
- `src/components/Line/index.tsx` - Refactored from class to functional component
- `src/components/Line/LineOriginalIndex.tsx` - Backup of original class component



</details>

---

## Template for Future Entries

### [Status Icon] [Task Name]
**Summary:** [1-2 sentence summary of what was done and the key outcome]

<details>
<summary>
<strong>📖 Click to expand full details</strong>
</summary>


**Component/File:** `path/to/file`

#### Problem Encountered
[Description of the issue]

#### Root Cause Analysis
[What caused the problem]

#### Solution Implemented
[How you fixed it - use bullet points or code blocks]

#### Key Learnings
[What you learned from this - numbered list]

#### Files Modified
- `path/to/file1` - [description]
- `path/to/file2` - [description]



</details>

---

**Status Icons:**
- ✅ Completed
- 🚧 In Progress
- ❌ Blocked
- 🔄 Refactored
- 🐛 Bug Fix
- ✨ New Feature


---

## Purpose
This document tracks daily development work, challenges, and solutions. It serves as a reference for future debugging and learning.


## Instructions for AI Assistant
When the user asks you to update this log:
1. Add a new entry under the appropriate date
2. Use the collapsible format: short summary visible, detailed content hidden in `<details>` tags
3. Include: task description, problems encountered, solutions implemented, and key learnings
4. Keep summaries to 1-2 sentences, put details in the expandable section
5. Preserve all existing entries - only append new ones
6. Always place newest entries at the top (after the header), with older entries below

---