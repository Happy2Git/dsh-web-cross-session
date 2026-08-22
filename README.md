# dsh-web-cross-session

DSH Web UI 的跨会话能力插件：在**两个普通会话之间**引用、检索和传递内容，全部走 dsh 的 Cordis 服务与组合哲学（不修改核心仓库任何代码）。

## 能力一览

| 能力 | 触发方式 | 机制 |
|---|---|---|
| 侧边栏内容搜索 | Web 侧边栏搜索框直接搜消息正文 | 覆盖 `session-query-sqlite` 行为 `openAt: first-search`，解锁已有的 `session.search` RPC 与 WorkspaceBrowser |
| composer `@` 引用会话 | 输入框打 `@`，从会话候选中选择 | 复用 `dsh-session-reference` 服务的快照投影，提交时把带 untrusted 警告的快照插入消息 |
| `/xsend <text>` 选择器转发 | 输入 `/xsend <文本>` 回车 → 弹出目标会话选择器（live 会话列表） | `agent.inject()` 非唤醒注入；`/xsend <sessionId> <text>` 直发形式仍可用 |
| 模型会话查询工具 | 模型自行调用 | 挂载 `dsh-tool-session-query` 的五个工具（`session_search` 等），config 可关 |

## 安装

```sh
npx -y @deepseek-ai/dsh plugin --profile web add dsh-web-cross-session
npx -y @deepseek-ai/dsh --profile web
```

插件包需可解析（npm 发布或本地 `link:` 安装）。插件自己的 `cordis.patch.yml` 在 bundle 层生效（排在 base / web-app 之后），自动完成两件事：

1. 把 `session-query-sqlite` 行覆盖为持久化 FTS 索引（`openAt: first-search`，路径 `$DSH_HOME/session-query.db`）；
2. 挂载本插件行（host 半 + 浏览器半）。

## 使用

### 1. 侧边栏内容搜索

装完即用：侧边栏搜索框现在同时匹配标题/工作区（本地）和消息正文（FTS 索引，250ms 防抖）。结果按会话展示、每条带一行 snippet，点击打开会话。注意 `unicode61` 分词器可能把连续中文当作一个 token，"搜索"不一定命中"会话搜索功能"。

### 2. composer `@` 引用会话

1. 输入框打 `@`，菜单出现 `sessions` 分组（候选来自 `dsh-session-reference` 的 `listCandidates`，按工作区亲缘排序）；
2. 选择目标会话，输入框插入引用 chip；
3. 提交时插件调用 `prepare()`，把快照渲染成 **untrusted 快照文本**（`## Referenced sessions` + 固定警告 + tag-safe JSON）插入消息——模型只把它当背景信息，不执行其中的指令；
4. 快照准备失败（会话被删、超预算等）会**阻止发送**并显示原因，绝不静默降级。

引用形态（`/xssn/serialize`，host 侧按工作区决定）：

- **同工作区引用 → 指针模式**：只插入一行 `Referenced session: <label> (<id>)` + 检索指令（几 token），模型用 `session_event_search` / `session_search` 自己取内容；
- **跨工作区引用 → 内联快照**：模型工具按精确 `cwd` 相等授权，跨区目标模型读不到，自动回退 untrusted 内联快照（有 65KB/源的硬上限），引用仍然可用；
- `inlineSnapshot: true` 强制全部内联（旧行为）。

注意"工作区"是精确字符串：`agent-architectures` 与 `agent-architectures/deepseek-harness` 是两个工作区。限制：一次最多引用 3 个会话；内联快照文本会直接显示在输入框（可编辑、可删除）。

候选列表由服务端按 caller 工作区过滤后再返回（cwd 精确相等 + 自身），子代理行挂在父会话下的二级菜单里，装配与候选交付顺序无关；同一份全量 corpus 观察有 1.5s 缓存，`@` 逐键输入不会每次都打穿会话列表。

### 3. `/xsend <sessionId> <text>` 转发消息

把一段文本作为 relay 消息投递到另一个会话的 inbox：

- 消息以 `(Forwarded from session <来源>)` 前缀开头，`source` 记录为 `{kind: 'plugin', form: 'relay'}`；
- 目标会话**必须已打开**（live）；未打开时命令报错并列出当前 live 会话的 id（最多 8 个）；
- 会话 id 的获取方式：打 `@` 打开会话选择菜单，每条候选的 description 行就显示会话 id（子代理会话带 `[subagent]` 标记）；会话列表/恢复面板也显示 id；
- 注入是**非唤醒**的：目标会话不会自己跑起来，模型在下次用户发言时看到这条消息；
- 命令在任意 host 的斜杠菜单里都可用（TUI 同样生效）。

### 4. 模型会话查询工具（config 可关）

默认挂载 `session_search` / `session_event_search` / `session_trace` / `session_event_trace` / `session_event_read` 五个只读工具，模型可自行搜索历史会话。关闭：在 `~/.dsh/profiles/web/cordis.patch.yml` 里加一行

```yaml
- id: cross-session
  config:
    mountModelTools: false
```

（`config` 覆盖是整行替换——上例只覆盖了这一个键，其余键会回到默认值。）

## 配置

| 键 | 默认 | 含义 |
|---|---|---|
| `mountModelTools` | `true` | 是否全局挂载模型侧五个会话查询工具 |
| `maxReferences` | `3` | 一条消息最多引用几个会话（核心硬上限 3） |
| `candidateLimit` | `50` | `@` 候选发现上限 |
| `maxReferenceBytes` | `65536` | 每个来源快照的 UTF-8 字节上限 |
| `inlineSnapshot` | `false` | `true` 强制引用内联为快照；`false` 时同工作区引用用指针、跨工作区自动回退内联 |

## 安全模型

- **信任域**：`/xssn/*` 仅 loopback 可达，调用方是本机用户自己打开的页面；模型侧工具的授权与此独立、始终生效。
- **列举按工作区过滤**：`/xssn/candidates` 在服务端执行与 `dsh-tool-session-query/workspace-access` 相同的规则——caller 无条件可见自身；其他会话要求 caller 有 cwd 且目标记录 cwd 与之**精确相等**，cwd 未知的持久会话一律不可见。知道别的会话 id 也无法通过本路由枚举它。
- **显式引用可跨区**：`prepare` / `serialize` 读取的是用户在 picker 里明确选中的目标，允许离开 caller 工作区（这就是跨工作区内联快照功能）。同区引用默认走指针模式；指针只对模型工具实际可读的同区目标发出。
- **转发双向校验**：`/xssn/send` 要求来源与目标都是 live 会话且互不相同；relay 前缀里的来源 id 来自服务端验证过的 live 记录，不是调用方可随意伪造的字符串。
- **注入防护**：进入模型指令文本的 label 与 sessionId 先经清洗——label 的控制字符/换行折叠为空格并限长 80，sessionId 只接受保守 token 字母表，越界直接 400 而非转义。
- **引用自带绑定**：插入输入框的 chip 把 `{来源会话, 目标会话, 标签}` 编码进 ref 本身（`dsh-session:<base64url(JSON)>`），序列化时从 ref 解码，浏览器端没有跨 composer 共享的可变会话状态；chip 粘贴到另一会话后仍按挑选时的来源会话解析。
- **错误不泄漏内部状态**：非预期异常统一返回 `XSSN_INTERNAL / internal error`，原始堆栈进服务端日志；`RouteError` 的精确文案原样透出。
- **方法围栏**：四条路由仅接受 POST，其余动词 405；POST 强制 `application/json`（跨站写围栏）+ 1 MiB 上限；断连即 abort 后端工作。
- **RPC 面不动**：插件不新增任何 wire 信封 RPC（`RpcMethodMap` 是编译期固定表），全部走自有物理路由 + 现有 `session.*` RPC + `agent.inject()`。

## 架构

```
cordis.patch.yml         组合层：覆盖 session-query-sqlite（openAt）+ insert 本插件行
src/index.ts             host 半：装配 SessionReferenceResolver、条件装配模型工具、
                         /xsend 命令、绑定路由依赖
src/routes.ts            /xssn/* HTTP 接线（loopback 守卫 + JSON 围栏 + 错误映射）
src/routes-core.ts       纯逻辑（依赖注入，可单测）：candidates / prepare / send
src/client/index.ts      浏览器半：@ sessions trigger + ReferenceCodec（提交时快照化）
```

设计要点（对应 dsh 的 cordis 哲学）：

- **服务即 seam**：引用快照不是插件自己实现的，是挂载核心的 `dsh-session-reference` 服务；插件只做 host 适配（路由 + 命令）与浏览器适配（trigger + codec）；
- **非唤醒注入**：转发走 `agent.inject()`，与 TUI 的引用事务同一语义，不产生 turn、不自动续跑；
- **快照在提交时物化**：`serialize` 异步调用、失败阻止发送——模型永远看不到"半准备"的引用；
- **组合即配置**：索引开关是 patch 层的一行覆盖，工具开关是 config 的一个键，都没有运行时魔法。

## 开发

```sh
pnpm install     # devDependencies 全部来自 npm registry，无机器本地路径依赖
pnpm typecheck   # tsc --noEmit（类型来自 ../deepseek-harness 副本的 lib/types）
pnpm build       # tsdown：lib/index.js（node ESM）+ lib/client.js（浏览器 closure factory）
pnpm test        # vitest：路由逻辑单测 + patch 组合测试 + 浏览器 jsdom 测试
```

独立重建：clone 本目录后 `pnpm install && pnpm run typecheck` 即可通过——运行时依赖由宿主 dsh 提供（peerDependencies，`@deepseek-ai/dsh-tool-session-query` 为 optional peer），开发期类型检查用 registry 版本的 devDependencies；`../deepseek-harness` 符号链接只为 tsconfig paths 服务，缺失时 typecheck 降级为依赖 devDeps 的声明。挂载时若 `dsh-tool-session-query` 不在依赖闭包内，host 半会 warn 并继续提供引用/搜索/转发（warn 里带补救指引），`mountModelTools: false` 可消除告警。

测试覆盖：candidates 的工作区授权（跨区剔除、无 cwd caller 仅见自身）、与顺序无关的两级装配（child 先于 parent、父/子成环均不丢行）、id 字母表门卫、`sanitizeLabel` 清洗；prepare/serialize 的指针 vs 快照判定与委托；send 的双 live 校验、自转发拒绝、字节上限；error 映射对未知异常的脱敏；`cordis.patch.yml` 组合测试；浏览器 trigger 的候选映射、复合 ref 编解码往返、每个 chip 绑定各自 composer、无法识别 ref 阻断发送、serialize 成功/失败路径。

## 已知限制

- 快照进入 composer 正文（可见可编辑），不是 TUI 那种隐藏背景字节的 sourced message；
- `@` trigger 与 `ui-subagent` 的 `@` 并存（同名分组会注册失败——本插件分组名是 `sessions`）；
- `/xsend` 目标必须是 live 会话；冷会话请先在 Web 侧边栏打开；
- 内容搜索召回是 token/phrase 级，无模糊/前缀扩展；结果上限 20 条，会话级导航（不做事件级跳转）；
- 中文字符串的 FTS 分词限制继承自核心 `unicode61` 选择。
