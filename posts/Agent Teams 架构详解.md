---
title: Agent Teams 架构详解
date: 2026-04-12
status: published
published_at: 2026-05-26T12:49:26+08:00
updated_at: 2026-05-26T12:49:26+08:00
---

# Claude Code Agent Teams 完整架构详解

> 基于官方文档和实际文件系统的深度解析
> 创建时间：2026-04-12

---

## 目录

1. [概述](#1-概述)
2. [文件系统结构](#2-文件系统结构)
3. [核心组件详解](#3-核心组件详解)
4. [任务依赖管理](#4-任务依赖管理)
5. [消息通信机制](#5-消息通信机制)
6. [并发控制](#6-并发控制)
7. [完整工作流程](#7-完整工作流程)
8. [数据流示例](#8-数据流示例)
9. [Subagent vs Teammate](#9-subagent-vs-teammate)

---

## 1. 概述

### Agent Teams 是什么？

Agent Teams 是 Claude Code 中**多个独立 Claude 实例协作**的机制。

### 核心特性

| 特性 | 说明 |
|------|------|
| **独立上下文** | 每个 teammate 有自己的 context window |
| **直接通信** | Teammates 可以直接互相发消息（不是通过 lead） |
| **共享任务列表** | 所有 teammates 看到同样的任务状态 |
| **异步消息** | 消息持久化，不要求接收者在线 |
| **任务依赖管理** | 自动处理任务之间的阻塞关系 |
| **并发控制** | 文件锁防止同时 claim 同一任务 |

### 与 Subagents 的区别

| | Subagents | Agent Teams |
|---|---|---|
| **上下文** | 独立上下文 | 独立上下文 |
| **通信** | 只能向主 agent 报告 | Teammates 直接互相通信 |
| **协调** | 主 agent 管理所有工作 | 共享任务列表，自我协调 |
| **适用场景** | 专注任务，只看结果 | 需要讨论和协作的复杂任务 |
| **Token 成本** | 较低（结果汇总到主上下文） | 较高（每个 teammate 独立实例） |

---

## 2. 文件系统结构

### 2.1 完整目录树

```
~/.claude/
│
├── teams/                                    ← Agent Teams 配置
│   ├── dress-up-dev-team/                    ← 团队 1
│   │   ├── config.json                       ← 团队配置
│   │   └── inboxes/                          ← 消息系统
│   │       ├── team-lead.json
│   │       ├── designer.json
│   │       └── frontend.json
│   │
│   └── quicktask-dev/                        ← 团队 2（当前活跃）
│       ├── config.json
│       └── inboxes/
│           └── team-lead.json
│
└── tasks/                                    ← 共享任务列表
    ├── dress-up-dev-team/
    │   ├── .lock                             ← 文件锁
    │   ├── 1.json
    │   └── 2.json
    │
    └── quicktask-dev/                        ← 当前团队的任务
        ├── .lock
        ├── 1.json
        ├── 2.json
        ├── 3.json
        ├── 4.json
        ├── 5.json
        └── 6.json
```

### 2.2 文件命名规则

| 路径模式 | 说明 |
|---------|------|
| `teams/{team-name}/` | 团队名称唯一标识 |
| `tasks/{team-name}/` | 任务列表与团队一一对应 |
| `inboxes/{agent-name}.json` | 每个 teammate 一个 inbox，名称即通信标识 |

---

## 3. 核心组件详解

### 3.1 团队配置 (`config.json`)

**位置**：`~/.claude/teams/{team-name}/config.json`

**作用**：存储团队的运行时状态和成员信息

**实际内容示例**：

```json
{
  "name": "quicktask-dev",                           // 团队唯一标识
  "description": "开发 QuickTask ToDo App - 一个简洁高效的个人任务管理工具",
  "createdAt": 1775894086824,                        // 创建时间（Unix 毫秒时间戳）
  "leadAgentId": "team-lead@quicktask-dev",          // Lead agent 的唯一 ID
  "leadSessionId": "de6018dd-aa5e-415e-8677-c57569528319",  // Lead 会话 ID
  "members": [                                       // 团队成员数组
    {
      "agentId": "team-lead@quicktask-dev",          // 成员唯一 ID（格式：name@team）
      "name": "team-lead",                           // 成员名称（用于 SendMessage 通信）
      "agentType": "team-lead",                      // 成员类型：team-lead 或 general-purpose 等
      "model": "GLM-4.7",                            // 该成员使用的模型
      "joinedAt": 1775894086824,                     // 加入团队的时间
      "tmuxPaneId": "",                              // tmux 面板 ID（split-pane 模式时使用）
      "cwd": "/Users/yams/ask-dir",                  // 工作目录
      "subscriptions": []                            // 事件订阅列表（用于接收特定事件通知）
    }
  ]
}
```

**关键字段说明**：

| 字段 | 类型 | 说明 | 示例值 |
|------|------|------|--------|
| `name` | string | 团队名称，用于识别和文件夹命名 | `"quicktask-dev"` |
| `leadAgentId` | string | Lead 的唯一标识符 | `"team-lead@quicktask-dev"` |
| `members[].name` | string | 成员名称，**这是 SendMessage 通信时使用的标识** | `"designer"`, `"frontend"` |
| `members[].agentId` | string | 成员的系统级唯一 ID | `"designer@quicktask-dev"` |
| `members[].tmuxPaneId` | string | tmux 面板 ID，用于 split-pane 模式的界面管理 | `"%2"` 或空字符串 |

**重要**：
- `name` 字段是通信的关键！当你要给某个 teammate 发消息时，使用的是这个 `name`
- 例如：`SendMessage({to: "designer", message: "..."})`
- 配置文件由系统自动创建和维护，**不要手动编辑**

---

### 3.2 消息收件箱 (`inboxes/{member-name}.json`)

**位置**：`~/.claude/teams/{team-name}/inboxes/{agent-name}.json`

**作用**：存储发给该 teammate 的所有消息，实现持久化异步通信

**实际内容示例**：

```json
[
  {
    "from": "team-lead",                            // 发送者名称
    "text": "{\"type\":\"task_assignment\",\"taskId\":\"1\",\"subject\":\"创建 UI/UX 设计稿\",\"description\":\"基于 todo-app/design/DESIGN.md 使用 Pencil MCP 工具创建完整的可交互设计原型。包括：1) 主界面布局 2) 任务列表组件 3) 输入区域 4) 底部统计 5) 交互动画。输出为 .pen 文件。\",\"assignedBy\":\"team-lead\",\"timestamp\":\"2026-04-11T07:55:35.164Z\"}",
    "timestamp": "2026-04-11T07:55:35.164Z",       // 消息发送时间
    "read": true                                    // 是否已读
  },
  {
    "from": "designer",                             // 来自其他 teammate
    "text": "{\"type\":\"design_update\",\"status\":\"completed\",\"file\":\"/path/to/design.pen\"}",
    "timestamp": "2026-04-11T08:15:22.123Z",
    "read": false                                   // 未读消息
  }
]
```

**消息类型**（常见类型）：

| 类型 | 说明 | 典型场景 |
|------|------|----------|
| `task_assignment` | 任务分配 | Lead 分配任务给 teammate |
| `task_update` | 任务状态更新 | 完成任务、标记失败 |
| `design_update` | 设计更新 | Designer 通知设计稿变更 |
| `api_contract_update` | API 契约更新 | Backend 通知 API 变更 |
| `question` | 询问 | 需要信息或澄清 |
| `answer` | 回答 | 回应询问 |
| `shutdown_request` | 关闭请求 | Lead 请求 teammate 停止 |
| `shutdown_response` | 关闭响应 | Teammate 接受或拒绝关闭 |

**消息投递机制**：

```
Frontend teammate                    Designer teammate
    │                                    │
    │  1. 调用 SendMessage               │
    │     {to: "Designer", ...}          │
    │                                    │
    │  2. 写入 designer.json             │
    │══════════════════════════════════> │
    │     ~/.claude/teams/.../inboxes/   │
    │             designer.json          │
    │                                    │
    │  3. Designer 后台进程检测新消息     │
    │     (自动轮询或文件监听)            │
    │                                    │
    │  4. Designer 收到通知，读取消息     │
    │<══════════════════════════════════ │
    │                                    │
    │  5. Designer 处理并回复             │
    │<══════════════════════════════════ │
    │                                    │
```

**特点**：
- ✅ **异步**：发送者不需要等待接收者在线
- ✅ **持久化**：消息存储在文件中，系统重启后不丢失
- ✅ **自动推送**：接收者会自动收到新消息通知
- ✅ **可追溯**：所有消息都有时间戳记录

---

### 3.3 共享任务列表 (`tasks/{team-name}/{task-id}.json`)

**位置**：`~/.claude/tasks/{team-name}/{task-id}.json`

**作用**：团队共享的任务状态管理，支持依赖关系和并发控制

**实际内容示例**：

```json
{
  "id": "2",                                      // 任务唯一 ID
  "subject": "实现前端 HTML 结构",                  // 任务标题
  "description": "根据设计稿实现 frontend/index.html。包含语义化的 HTML 结构，支持响应式设计，包含输入框、任务列表容器、统计区域等核心元素。",
  "activeForm": "实现前端 HTML 结构",               // 进行时态（用于 UI 显示："正在实现前端 HTML 结构"）
  "status": "completed",                           // 状态：pending / in_progress / completed
  "owner": "team-lead",                            // 当前负责人（空表示无人认领）
  "blocks": [],                                    // 此任务阻塞了哪些任务（任务 ID 数组）
  "blockedBy": ["1"]                               // 此任务被哪些任务阻塞（任务 ID 数组）
}
```

**任务状态生命周期**：

```
pending (待处理)
    │
    │  [被某人认领]
    ▼
in_progress (进行中)
    │
    │  [完成或失败]
    ▼
completed (已完成) ← 或 deleted (已删除)
```

**任务字段详解**：

| 字段 | 类型 | 说明 | 示例值 |
|------|------|------|--------|
| `id` | string | 任务唯一标识 | `"1"`, `"2"` |
| `subject` | string | 任务简短标题 | `"创建 UI/UX 设计稿"` |
| `description` | string | 详细描述 | `"基于设计文档..."` |
| `activeForm` | string | 进行时态描述 | `"创建 UI/UX 设计稿"` |
| `status` | string | 任务状态 | `"pending"`, `"in_progress"`, `"completed"`, `"deleted"` |
| `owner` | string | 当前负责人 | `"designer"`, `"frontend"` 或空 |
| `blocks` | string[] | 此任务阻塞的任务 ID 列表 | `["3", "4", "5"]` |
| `blockedBy` | string[] | 阻塞此任务的任务 ID 列表 | `["1"]` |

---

## 4. 任务依赖管理

### 4.1 依赖关系图

**示例场景**：QuickTask ToDo App 开发

```
任务 1: 创建 UI/UX 设计稿
  │
  ├─> 任务 2: 实现前端 HTML (blockedBy: ["1"])
  ├─> 任务 3: 实现前端 CSS  (blockedBy: ["1"])
  └─> 任务 4: 实现前端 JS   (blockedBy: ["1"])
       │
       └─> 任务 6: 集成测试和部署 (blockedBy: ["4", "5"])

任务 5: 实现后端 API 服务器 (独立，无依赖)
  │
  └─> 任务 6: 集成测试和部署 (blockedBy: ["4", "5"])
```

### 4.2 依赖关系的 JSON 表示

**任务 1（设计稿）**：
```json
{
  "id": "1",
  "subject": "创建 UI/UX 设计稿",
  "status": "completed",
  "blocks": ["2", "3", "4"],      // 阻塞任务 2、3、4
  "blockedBy": []                 // 无前置依赖
}
```

**任务 2（HTML）**：
```json
{
  "id": "2",
  "subject": "实现前端 HTML 结构",
  "status": "pending",
  "blocks": [],                   // 不阻塞任何任务
  "blockedBy": ["1"]              // 等待任务 1 完成
}
```

**任务 6（集成测试）**：
```json
{
  "id": "6",
  "subject": "集成测试和部署",
  "status": "pending",
  "blocks": [],
  "blockedBy": ["4", "5"]         // 必须等待任务 4 和 5 都完成
}
```

### 4.3 自动解除阻塞机制

**工作原理**：

```
时刻 T1:
  任务 1: in_progress
  任务 2: pending (blockedBy: ["1"])
  任务 3: pending (blockedBy: ["1"])

  ↓ Designer 完成任务 1 ↓

时刻 T2:
  任务 1: completed
  ↓ 系统自动检测并更新依赖
  任务 2: pending (blockedBy: []) ← 阻塞解除！
  任务 3: pending (blockedBy: []) ← 阻塞解除！

  ↓ Frontend teammate 检测到任务 2 可用 ↓

时刻 T3:
  任务 2: in_progress (Frontend 已认领)
```

**代码逻辑**：

```javascript
// 当任务 A 完成时
function onTaskCompleted(taskA) {
  // 1. 找到所有被 A 阻塞的任务
  const blockedTasks = getAllTasks().filter(t =>
    t.blockedBy.includes(taskA.id)
  )

  // 2. 从它们的 blockedBy 数组中移除 A
  blockedTasks.forEach(task => {
    task.blockedBy = task.blockedBy.filter(id => id !== taskA.id)
    saveTask(task)
  })

  // 3. 通知所有 teammates 有新任务可用
  notifyAllTeammates("new_tasks_available")
}
```

---

## 5. 消息通信机制

### 5.1 SendMessage 工具详解

**工具签名**：

```javascript
SendMessage({
  to: "teammate-name",           // 必需：接收者名称（对应 config.json 中的 name）
  summary: "简短摘要",           // 可选：在 UI 中显示的预览
  message: "完整的消息内容"      // 必需：消息正文或结构化数据（JSON 字符串）
})
```

**使用示例**：

```javascript
// 示例 1：简单文本消息
SendMessage({
  to: "Frontend",
  summary: "设计稿已完成",
  message: "UI/UX 设计稿已完成，保存在 todo-app/design/design.pen，可以开始实现前端了。"
})

// 示例 2：结构化消息（推荐）
SendMessage({
  to: "Frontend",
  message: {
    type: "design_update",
    status: "completed",
    file: "/Users/yams/ask-dir/todo-app/design/design.pen",
    description: "完整的 UI 设计，包含所有页面和交互状态"
  }
})

// 示例 3：广播给所有人
SendMessage({
  to: "*",                       // * 表示广播
  message: "API 契约已更新，请大家查看 docs/api-contract.md"
})
```

### 5.2 消息投递流程

```
┌─────────────────────────────────────────────────────────────┐
│                      Mailbox System                          │
│                  (消息投递和通知系统)                         │
└─────────────────────────────────────────────────────────────┘
                            │
        ┌───────────────────┼───────────────────┐
        │                   │                   │
        ▼                   ▼                   ▼
┌───────────────┐   ┌───────────────┐   ┌───────────────┐
│team-lead.json │   │designer.json  │   │frontend.json  │
│               │   │               │   │               │
│[msg1, msg2]  │   │[msg3]         │   │[msg4, msg5]   │
└───────────────┘   └───────────────┘   └───────────────┘
        │                   │                   │
        │                   │                   │
    Lead 读取          Designer 读取        Frontend 读取
```

**投递保证**：
- ✅ **至少一次投递**：消息会被写入文件，即使接收者离线
- ✅ **顺序保证**：来自同一发送者的消息按顺序投递
- ✅ **不丢失**：文件系统持久化，重启后仍可读取

### 5.3 消息读取和通知

**Teammate 如何知道有新消息？**

1. **自动轮询**：后台进程定期检查 inbox 文件
2. **文件监听**：使用文件系统监听 API（如 `fs.watch`）
3. **主动拉取**：每次任务完成后检查收件箱

**读取逻辑**：

```javascript
function checkInbox(agentName) {
  const inbox = readJSON(`~/.claude/teams/{team}/inboxes/${agentName}.json`)

  const unreadMessages = inbox.filter(msg => !msg.read)

  if (unreadMessages.length > 0) {
    // 标记为已读
    unreadMessages.forEach(msg => msg.read = true)
    saveInbox(agentName, inbox)

    // 处理消息
    unreadMessages.forEach(msg => {
      handleMessage(msg)
    })
  }
}

function handleMessage(msg) {
  const data = JSON.parse(msg.text)

  switch (data.type) {
    case "task_assignment":
      // Lead 分配了新任务
      log(`收到任务: ${data.subject}`)
      break
    case "design_update":
      // 设计更新
      if (data.status === "completed") {
        log(`设计已完成，文件: ${data.file}`)
      }
      break
    case "shutdown_request":
      // 请求关闭
      respondToShutdown(data)
      break
  }
}
```

---

## 6. 并发控制

### 6.1 文件锁机制

**位置**：`~/.claude/tasks/{team-name}/.lock`

**作用**：防止多个 teammates 同时 claim 同一个任务

**问题场景**：

```
时刻 T:
  任务 2 状态：pending，无人认领

  ↓ Frontend teammate 和 Backend teammate 同时看到 ↓

冲突！：
  Frontend: 我要 claim 任务 2！
  Backend:  我也要 claim 任务 2！
  结果：两人都认为自己在做任务 2 → 浪费资源
```

**解决方案：文件锁**

```
Frontend teammate                  .lock 文件                Backend teammate
      │                               │                            │
      │  1. 检查 .lock 是否存在        │                            │
      │  2. 不存在 → 创建 .lock        │                            │
      │  3. claim 任务 2               │                            │
      │<──────────────┐               │                            │
      │               │               │                            │
      │               │               │                            │  1. 检查 .lock
      │               │               │                            │  2. .lock 已存在！
      │               │               │                            │  3. 等待或选择其他任务
      │               │               │                            │
      │  4. 完成任务 2                │                            │
      │  5. 释放 .lock                │                            │
      │<──────────────┘               │                            │
      │                               │                            │
      │                               │                            │  4. 检查 .lock
      │                               │                            │  5. .lock 不存在了
      │                               │                            │  6. claim 其他任务
```

### 6.2 Claim 任务的原子操作

**代码逻辑**：

```javascript
function claimTask(taskId, agentName) {
  const lockPath = `~/.claude/tasks/{team}/.lock`

  // 1. 尝试创建锁文件（原子操作）
  try {
    fs.writeFileSync(lockPath, process.pid, { flag: 'wx' })
  } catch (e) {
    // 锁已存在，说明有人在操作任务列表
    return { success: false, reason: "locked" }
  }

  try {
    // 2. 读取任务
    const task = readTask(taskId)

    // 3. 检查任务是否可 claim
    if (task.status !== "pending") {
      return { success: false, reason: "not_pending" }
    }
    if (task.blockedBy.length > 0) {
      return { success: false, reason: "blocked" }
    }

    // 4. 更新任务
    task.status = "in_progress"
    task.owner = agentName
    saveTask(task)

    return { success: true, task }
  } finally {
    // 5. 释放锁
    fs.unlinkSync(lockPath)
  }
}
```

### 6.3 死锁预防

**潜在问题**：

```
Frontend 持有锁
    │
    │  [突然崩溃！]
    │
    .lock 文件永远存在 → 死锁
```

**解决方案**：

1. **锁超时**：检查锁文件的创建时间，超过阈值则强制删除
2. **PID 验证**：检查锁文件中的 PID 是否还在运行
3. **Leader 仲裁**：lead agent 可以强制清理死锁

```javascript
function acquireLock(lockPath) {
  // 检查锁是否过期
  if (fs.existsSync(lockPath)) {
    const lockTime = fs.statSync(lockPath).mtimeMs
    const lockPid = parseInt(fs.readFileSync(lockPath, 'utf8'))

    // 超过 30 秒或 PID 不存在 → 强制删除
    if (Date.now() - lockTime > 30000 || !isProcessRunning(lockPid)) {
      fs.unlinkSync(lockPath)
    }
  }

  // 创建新锁
  fs.writeFileSync(lockPath, process.pid, { flag: 'wx' })
}
```

---

## 7. 完整工作流程

### 7.1 创建团队流程

```
1. 用户请求创建团队
   ↓
2. Lead 调用 TeamCreate 工具
   ↓
3. 系统创建：
   - ~/.claude/teams/{team-name}/config.json
   - ~/.claude/teams/{team-name}/inboxes/team-lead.json
   - ~/.claude/tasks/{team-name}/.lock
   ↓
4. Lead 创建任务列表（使用 TaskCreate）
   ↓
5. Lead spawn teammates（使用 Agent 工具）
   ↓
6. 每个 teammate：
   - 读取 config.json 发现其他成员
   - 创建自己的 inbox
   - 开始监听消息和任务
   ↓
7. 团队开始协作！
```

### 7.2 Task Claim 流程

```
Teammate 空闲时
    │
    │  1. 检查任务列表
    ▼
┌─────────────────────────┐
│ 遍历所有任务             │
│ 找到 status=pending     │
│ 且 blockedBy=[] 的任务  │
└─────────────────────────┘
    │
    │  2. 找到可用任务
    ▼
┌─────────────────────────┐
│ 获取文件锁 .lock        │
│ 更新任务状态            │
│ status=in_progress      │
│ owner=teammate-name     │
└─────────────────────────┘
    │
    │  3. 开始执行任务
    ▼
┌─────────────────────────┐
│ 执行任务内容            │
│ (写代码、做设计等)      │
└─────────────────────────┘
    │
    │  4. 任务完成
    ▼
┌─────────────────────────┐
│ 更新任务状态            │
│ status=completed        │
│ 解除阻塞的其他任务      │
└─────────────────────────┘
    │
    │  5. 通知其他 teammates
    ▼
┌─────────────────────────┐
│ 发送消息或自动触发      │
│ 其他 teammates 检测     │
│ 新可用任务              │
└─────────────────────────┘
```

### 7.3 清理团队流程

```
1. 用户请求清理团队
   ↓
2. Lead 检查是否有活跃 teammates
   ↓
3. 如果有活跃 teammates → 失败，提示先关闭
   ↓
4. 如果没有活跃 teammates → 清理：
   - 删除 ~/.claude/teams/{team-name}/
   - 删除 ~/.claude/tasks/{team-name}/
   ↓
5. 团队资源完全清除
```

---

## 8. 数据流示例

### 8.1 场景：Designer 完成设计稿，通知 Frontend

**初始状态**：

```
任务 1: 设计稿 (in_progress, owner=designer)
  │
  └─> 任务 2: HTML (pending, blockedBy=["1"])
```

**步骤 1：Designer 完成设计**

```javascript
// Designer teammate 执行
design = createDesign()  // 使用 Pencil MCP 创建设计
saveFile("design.pen", design)

// 更新任务状态
TaskUpdate({
  taskId: "1",
  status: "completed"
})
```

**步骤 2：系统自动解除阻塞**

```javascript
// 系统内部逻辑
tasks = loadAllTasks()
task1 = tasks.find(t => t.id === "1")

// 找到所有被任务 1 阻塞的任务
blockedTasks = tasks.filter(t => t.blockedBy.includes("1"))

// 解除阻塞
blockedTasks.forEach(t => {
  t.blockedBy = t.blockedBy.filter(id => id !== "1")
  saveTask(t)
})
```

**结果**：

```
任务 1: 设计稿 (completed, owner=designer)
  │
  └─> 任务 2: HTML (pending, blockedBy=[]) ← 阻塞解除！
```

**步骤 3：Designer 通知 Frontend**

```javascript
// Designer teammate 发送消息
SendMessage({
  to: "Frontend",
  message: {
    type: "design_update",
    status: "completed",
    file: "/path/to/design.pen",
    description: "UI 设计已完成，包含主界面和所有组件"
  }
})
```

**步骤 4：消息投递**

```json
// 写入 ~/.claude/teams/quicktask-dev/inboxes/frontend.json
{
  "from": "Designer",
  "text": "{\"type\":\"design_update\",\"status\":\"completed\",...}",
  "timestamp": "2026-04-11T08:15:22.123Z",
  "read": false
}
```

**步骤 5：Frontend 收到通知**

```javascript
// Frontend teammate 后台进程
checkInbox("frontend")

// 发现未读消息
{
  type: "design_update",
  status: "completed",
  file: "/path/to/design.pen"
}

// 读取设计文件
design = readFile("design.pen")

// 检查任务列表，发现任务 2 可用
task2 = getTask("2")
if (task2.status === "pending" && task2.blockedBy.length === 0) {
  // Claim 任务
  claimTask("2", "Frontend")
}
```

**步骤 6：Frontend 开始实现**

```javascript
// Frontend teammate 执行
html = implementHTML(design)
saveFile("index.html", html)

TaskUpdate({
  taskId: "2",
  status: "completed"
})
```

### 8.2 完整协作序列图

```
Designer              Frontend              Backend               TaskList
    │                     │                     │                     │
    │ 1. claim 任务 1      │                     │                     │
    │─────────────────────>│                     │                     │
    │                     │                     │                     │
    │ 2. 完成设计           │                     │                     │
    │<─────────────────────│                     │                     │
    │                     │                     │                     │
    │ 3. TaskUpdate(1,     │                     │                     │
    │    completed)        │                     │                     │
    │─────────────────────────────────────────────────────────────────>│
    │                     │                     │                     │
    │                     │ 4. 检测任务 2 可用   │                     │
    │                     │<────────────────────│                     │
    │                     │                     │                     │
    │ 5. SendMessage(      │                     │                     │
    │    to: Frontend)     │                     │                     │
    │══════════════════════>│                     │                     │
    │                     │                     │                     │
    │                     │ 6. claim 任务 2      │                     │
    │                     │─────────────────────>│                     │
    │                     │                     │                     │
    │                     │ 7. 实现 HTML         │                     │
    │                     │                     │                     │
    │                     │ 8. TaskUpdate(2,     │                     │
    │                     │    completed)        │                     │
    │                     │────────────────────────────────────────────>│
    │                     │                     │                     │
    │                     │ 9. 检测任务 4 可用   │                     │
    │                     │<────────────────────│                     │
    │                     │                     │                     │
    │                     │ 10. claim 任务 4     │                     │
    │                     │─────────────────────>│                     │
    │                     │                     │                     │
    │                     │ ...                 │                     │
```

---

## 9. Subagent vs Teammate

### 9.1 Subagent Definitions（角色模板）

**定义**：可重用的代理"角色"配置

**存储位置**：

```
.claude/
└── agents/
    ├── code-reviewer.md       ← 项目级别
    ├── security-reviewer.md
    └── ui-designer.md

~/.claude/
└── agents/                    ← 全局级别
    └── (通用 agents)
```

**示例**：`.claude/agents/ui-designer.md`

```markdown
---
name: ui-designer
description: 专业的 UI/UX 设计师
model: sonnet
tools:
  - Read
  - Write
  - mcp__pencil__*
---

你是一个专业的 UI/UX 设计师。你负责：
- 使用 Pencil MCP 工具创建设计稿
- 遵循现代设计原则
- 输出 .pen 文件
- 与前端开发密切协作

工作流程：
1. 阅读需求和设计文档
2. 创建初步设计稿
3. 与团队讨论和迭代
4. 输出最终设计文件
```

### 9.2 Teammate Instances（运行时实例）

**定义**：由 team-lead spawn 的实际运行的 teammate

**特点**：
- 每个 teammate 是一个独立的 Claude Code 实例
- 有自己的上下文窗口
- 可以选择使用某个 subagent definition 作为"角色"
- 运行时状态存储在 `~/.claude/teams/{team-name}/`

### 9.3 作用域和重用

| 类型 | 位置 | 作用域 | 可重用 | 生命周期 |
|------|------|--------|--------|----------|
| **Subagent Definition** | `.claude/agents/*.md` | 当前项目 | ✅ 在该项目中可多次使用 | 持久化 |
| **Subagent Definition** | `~/.claude/agents/*.md` | 全局 | ✅ 在所有项目中可使用 | 持久化 |
| **Agent Team** | `~/.claude/teams/{name}/` | 全局 | ❌ 每次运行时创建 | 会话级 |
| **Teammate Instance** | 运行时内存 | 当前团队会话 | ❌ 临时实例 | 会话级 |

### 9.4 使用示例

**在项目中创建 subagent definition**：

```bash
# 创建 .claude/agents/ 文件夹
mkdir -p .claude/agents

# 创建 ui-designer.md
cat > .claude/agents/ui-designer.md << 'EOF'
---
name: ui-designer
description: UI/UX 设计专家
model: sonnet
---
(配置内容...)
EOF
```

**在 Agent Team 中使用**：

```bash
# 启动 Claude Code
claude

# 自然语言请求
"创建一个团队来实现 ToDo App，spawn 一个 ui-designer teammate"
```

**Lead 会**：
1. 读取 `.claude/agents/ui-designer.md`
2. 创建 teammate 实例
3. 应用 subagent definition 的配置
4. 启动独立的 Claude 实例

---

## 10. 最佳实践

### 10.1 团队规模

| teammates 数量 | 适用场景 | 注意事项 |
|---------------|----------|----------|
| 1-3 | 简单任务 | 协调成本低 |
| 3-5 | **推荐** 大多数场景 | 平衡并行度和协调成本 |
| 5-10 | 复杂大型项目 | 需要仔细规划任务 |
| 10+ | 不推荐 | 协调成本过高 |

### 10.2 任务粒度

| 任务规模 | 预计时间 | 适用场景 |
|---------|---------|----------|
| 太小 | <5 分钟 | 协调开销超过收益 |
| **合适** | 30分钟-2小时 | ✅ 推荐 |
| 太大 | >4 小时 | 风险高，难以追踪 |

**建议**：
- 每个 teammate 同时有 5-6 个任务可选择
- 任务应该能独立完成，减少等待

### 10.3 通信最佳实践

✅ **推荐**：
- 使用结构化消息（JSON）而非纯文本
- 消息类型明确（task_assignment, design_update 等）
- 包含必要的上下文信息

❌ **避免**：
- 广播给所有人（`to: "*"`）- 除非真正必要
- 过度频繁的消息
- 包含大量数据的消息（改用文件引用）

### 10.4 调试技巧

**查看团队状态**：

```bash
# 查看所有团队
ls -la ~/.claude/teams/

# 查看团队成员
cat ~/.claude/teams/quicktask-dev/config.json | jq '.members[] | {name, model, cwd}'

# 查看任务列表
ls -la ~/.claude/tasks/quicktask-dev/

# 查看某个任务
cat ~/.claude/tasks/quicktask-dev/1.json | jq '.'

# 查看消息队列
cat ~/.claude/teams/quicktask-dev/inboxes/frontend.json | jq '.[] | {from, timestamp, read}'
```

**检查锁状态**：

```bash
# 检查是否有锁
cat ~/.claude/tasks/quicktask-dev/.lock

# 检查锁的 PID 是否还在运行
ps -p $(cat ~/.claude/tasks/quicktask-dev/.lock)
```

---

## 11. 限制和已知问题

### 11.1 当前限制

| 限制 | 说明 | 影响 |
|------|------|------|
| **无法恢复 in-process teammates** | `/resume` 不恢复 teammates | 可能导致 lead 向不存在的 teammate 发消息 |
| **任务状态滞后** | 有时任务完成但未标记 | 需要手动更新或 nudge |
| **关闭慢** | Teammates 完成当前请求才关闭 | 可能需要等待 |
| **每个会话一个团队** | Lead 不能同时管理多个团队 | 需要先 cleanup |
| **无法嵌套团队** | Teammate 不能再创建团队 | 只能由 lead 创建 |

### 11.2 实验性功能警告

Agent Teams 仍然是**实验性功能**：
- API 可能变化
- 行为可能不稳定
- 生产环境需谨慎

---

## 12. 总结

### 核心要点

1. **文件系统驱动**：所有状态存储在文件中，可查看、可调试
2. **异步消息传递**：通过 inbox 文件实现持久化通信
3. **自动依赖管理**：blockedBy/blocks 自动处理任务依赖
4. **并发安全**：文件锁防止冲突
5. **独立上下文**：每个 teammate 有自己的 context window

### 文件结构速查

```
~/.claude/
├── teams/{team}/
│   ├── config.json          ← 团队配置和成员
│   └── inboxes/{name}.json  ← 消息收件箱
└── tasks/{team}/
    ├── .lock                ← 并发控制锁
    └── {id}.json            ← 任务定义和状态
```

### 关键概念

| 概念 | 位置 | 作用 |
|------|------|------|
| Team Lead | config.json | 协调者，创建和管理团队 |
| Teammate | config.json members[] | 独立的工作者 |
| Inbox | inboxes/*.json | 消息传递和存储 |
| Task | tasks/*.json | 工作单元和状态 |
| Dependency | tasks[].blockedBy | 任务依赖关系 |
| Lock | tasks/.lock | 并发控制 |

---

## 参考资源

- [Claude Code 官方文档 - Agent Teams](https://code.claude.com/docs/agent-teams)
- [Claude Code 官方文档 - Subagents](https://code.claude.com/docs/sub-agents)
- [TaskCreate 工具文档](https://code.claude.com/docs/tools/task-create)
- [SendMessage 工具文档](https://code.claude.com/docs/tools/send-message)

---

> **作者注**：本文档基于 Claude Code v2.1.101 的实际文件系统和官方文档编写。如有更新，请以最新官方文档为准。
