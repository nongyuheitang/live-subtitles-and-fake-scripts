# Replay Demo — 演示用回放式 fake provider（Cherry Studio 零改动）

> 本文件是原型目录的底层技术参考，保留了开发时的相对目录结构与探针说明。正式包的目录已经整理为 `tool/` 和 `examples/`，实际安装、启动和验收请以包根目录的 `README.md` 为准。

把一次成功的 agent 运行"重演"给观众看：本地 fake provider 按剧本回放模型输出（流式文本 + 工具调用），
MCP 替身工具箱假装执行命令（相同耗时、相同输出），产物文件在"保存"那一刻真实落盘，
最后由 Cherry 自己的 `report_artifacts` 把它变成可点击、可预览的对话产物。

默认 replay 模式不访问真实模型或远程服务器；原生工具版会执行受限的本地 `cp`、`sleep`、`Write`、`Read`、`Edit` 等步骤。Cherry Studio 源码一行未改。

## 组件

| 文件 | 角色 | 模式 |
|---|---|---|
| `provider-server.mjs` | 假 LLM 服务（Anthropic `/v1/messages` + OpenAI `/v1/chat/completions`，SSE） | `replay` 按剧本播 / `record` 透传真实上游并录制 |
| `mcp-toolbox.mjs` | stdio MCP 工具箱（`bash` / `save_file` / `read_file`） | `replay` 假执行（sleep 录制耗时 + 返回录制输出 + 产物落盘）/ `live` 真执行并录制 |
| `scripts/<name>/script.json` | **单一剧本文件**：台词、工具调用、工具结果、时长全在里面 | 人可编辑 |
| `scripts/<name>/assets/` | 演示产物（PDF 等）与其 HTML 源 | — |

现有剧本：

- **`scripts/server-inspection-native`**（**推荐**）— 用**内置工具名**，卡片与真实运行完全一致
  （`Find 收集更详细的服务器信息`），命令均为 `sleep N # 关键词`，零副作用。
  写法见 [TOOL-CARD-LABELS.md](./TOOL-CARD-LABELS.md)。
- `scripts/server-inspection` — 同剧情的 MCP 替身工具版（卡片显示 `toolbox : bash`），保留作对照
- `scripts/server-report` — 早期单轮示例
- **`scripts/ppt-demo`** — 由企业版 v1 真实会话自动转换而来：一句台词 → 10 分钟、48 轮、
  47 次工具调用（TodoWrite/Glob/Read/Bash/Write/Edit），真实产出 7 张 HTML 幻灯片 + 生成脚本

## 从 v1 企业版会话自动转换

企业版（v1）的每个 block 都带 `createdAt`，**分步耗时比 v2 还细**（v2 的 parts 没有时间戳）。
所以历史案例可以直接转成剧本，不用重跑：

```bash
node convert-v1-session.mjs --list                                   # 列出所有会话
node convert-v1-session.mjs --session PPT --only-turn 8 --out scripts/ppt-demo
```

转换器会自动：

- 按 block 时间差还原**每一步耗时**
- 把 v1 聚合成一条消息的多次 LLM 往返**拆回多轮**（回放必须如此）
- `Bash` 命令换成 `sleep N  # 原命令`（零副作用，标签不变）
- 把录制机器的绝对路径改写成 `{{OUTPUT_DIR}}`（避免真写到别处）
- 跳过 `Task`/`Agent`（会派生真实子智能体，打乱 turn 计数）

`--only-turn N` 用来从一段含试错的真实会话里裁出干净的那一轮（先不加该参数跑一次看轮次概览）。

**注意**：`Read`/`Glob`/`Edit` 会真执行。若某个 `Read` 的目标在剧本里没被 `Write` 创建过，
需要预置——把文件放进 `scripts/<name>/seed/`，并让第一条 Bash 顺带 `cp` 过去（`ppt-demo` 就是这么做的）。

### ⚠️ 产物必须先真生成一次，再回放

转换器把所有 `Bash` 换成了 `sleep`，所以**原本由命令生成的产物不会出现**
（`Write` 写的文本文件是真的，但 `node build.js` 产出的 PPTX/PDF/ZIP 不是）。
不处理的话，演示到最后点开文件会看到 **"File unavailable"**。

正确做法：

1. 先跑一次转换后的剧本，让 `Write` 把源文件（HTML/脚本）真实写出来
2. **在真实环境里把产物生成一次**，例如：
   ```bash
   cd <输出目录>
   NODE_PATH=<replay-demo>/node_modules:<repo>/node_modules node generate-ppt-simple.js
   ```
   （`replay-demo/` 下有独立的 `package.json`，产物生成用的依赖装在这里，不污染仓库）
3. 把产物存进 `scripts/<name>/assets/`
4. 把"生成产物"那一步的命令改成**先复制、再睡够原耗时**：
   ```
   cp "{{SCRIPT_DIR}}/assets/xxx.pptx" "{{OUTPUT_DIR}}/" && sleep 52 && echo "✓ done"  # node generate-ppt-simple.js
   ```

**顺序不能反**：`sleep N && <命令>` 会被 claude-agent-sdk 的护栏拦掉
（`Blocked: sleep N followed by: …`），必须把 `cp` 放在 `sleep` 前面。

同理，正文里若出现录制机器的绝对路径（"已保存到 /Users/xxx/…"），转换器会改写成 `{{OUTPUT_DIR}}`，
否则文案会指向演示机上不存在的位置。

> **用原生工具版时不需要挂 MCP toolbox**（`Bash` 由 SDK 自己执行），
> 只有 MCP 版才需要配 toolbox。

## 演示

```bash
# 起 provider（--out-dir 必须与 Cherry 里 agent 的工作目录一致）
node provider-server.mjs --script scripts/server-inspection --out-dir ~/Desktop/replay-demo-out
```

Cherry Studio 一次性配置（全部在界面完成，不改代码）：

1. **设置 → 模型服务 → 添加自定义 provider**：类型 **Anthropic**，API 地址 `http://127.0.0.1:8402`，
   密钥任意；点「获取模型列表」会拿到 `GLM-5.2`，添加它。
2. **设置 → MCP → Add → Import from JSON**（服务器名任意，UUID 会自动绑定）：
   ```json
   {"mcpServers":{"toolbox":{"command":"/opt/homebrew/bin/node","args":[
     "<绝对路径>/mcp-toolbox.mjs",
     "--script","<绝对路径>/scripts/server-inspection",
     "--out-dir","/Users/<你>/Desktop/replay-demo-out"]}}}
   ```
   导入后打开详情把开关打开。
3. **演示 agent → More → Edit Agent**：Basic 里主/计划/小模型全部选 `GLM-5.2`；
   MCP 标签页启用 `toolbox`；权限模式设 **Full Auto Mode**（否则每次工具调用都会弹审批）。
4. **新建会话后、发消息前**，在顶栏把**工作目录**设为 `~/Desktop/replay-demo-out`
   —— PDF 预览要求产物位于会话工作目录内（`AgentRightPane.tsx` 的 `canOpenArtifactFile`）。

然后按 `script.json` 里 `lines` 字段的台词依次发送即可。**每场演示新开一个会话**
（turn 由"历史里 assistant 消息条数"定位，在旧会话里续发会越界到剧本末尾）。

## 剧本格式

一个 `script.json` 描述整场演示。每个 turn 对应模型的一次回复：

```jsonc
{
  "match": { "anyOf": ["203.0.113.10"] },   // 主线识别关键词
  "turns": [
    {
      "blocks": [
        { "type": "text", "durationMs": 3200, "text": "…" },   // 流式打字时长
        {
          "type": "tool_use", "tool": "bash", "durationMs": 1800,
          "input": { "command": "…", "description": "…" },     // 显示在工具卡片上
          "result": {                                          // 有 result = 由 toolbox 假执行
            "durationMs": 12000,                               // 假装执行耗时
            "output": "…",                                     // 返回给模型/显示的输出
            "writeFile": { "from": "assets/x.pdf", "to": "x.pdf" }  // 可选：产物落盘
          }
        },
        {
          "type": "tool_use", "tool": "report_artifacts",      // 无 result = Cherry 自己真实执行
          "input": { "artifacts": [{ "path": "{{OUTPUT_DIR}}/x.pdf", "description": "…" }] }
        }
      ],
      "stop": "tool_use"        // tool_use = 还有下一轮；end_turn = 本轮说完
    }
  ],
  "fallbacks": [ { "whenBodyContains": "title", "text": "会话标题" } ]
}
```

- `{{OUTPUT_DIR}}` / `{{SCRIPT_DIR}}` 会在下发前展开为真实绝对路径。
- 总时长 = 所有 block 的 `durationMs` + 所有 `result.durationMs` 之和，直接改数字即可对齐目标时长。

### 时长保真度（实测）

时间是剧本参数，写多少跑多少，开销可忽略：

| 剧本设定 | 实测 | 误差 |
|---|---|---|
| `server-inspection` turn1–5：65.6s | ~66s | 0.6% |
| `long-run-probe` 单工具 95s（总 97.3s） | 98s，UI 显示 `1m 40s` | 0.7% |

**要复刻 20 分钟的任务，必须先调大 MCP 超时**（下节）。

### 长任务（>60 秒）必读

`McpRuntimeService.ts:1110` 里单次 MCP 工具调用**默认超时只有 60 秒**，超过就会被掐断。
复刻长任务前把 toolbox 的 `timeout` 调大（单位：秒）：

```js
// 在 Cherry 的 DevTools console 里执行；<id> 从 GET /mcp-servers 拿
window.api.dataApi.request({ method: 'PATCH', path: '/mcp-servers/<id>', body: { timeout: 1800 } })
```

- **不要开 Long Running Mode**：它会把 `maxTotalTimeout` 锁成 10 分钟硬顶（`:1114`），
  反而限制单个工具的最长时长。直接调大 `timeout` 没有这个封顶。
- 另有一层流式空闲超时 `DEFAULT_TIMEOUT = 30 分钟`（`src/main/ai/constants.ts:1`），
  按"两次 chunk 之间的间隔"计算。**单个工具**假执行别超过 30 分钟即可；
  总时长 20 分钟完全安全。
- 真实跑 20 分钟的任务通常是很多步而非一步 20 分钟，把时长分摊到各步更稳妥。

## 接入别人机器上跑出的真实案例

让对方把 `collect-session.js` 全文粘进 Cherry Studio 的 DevTools Console（⌥⌘I → Console）执行，
会自动下载一个 `replay-bundle-*.json`。**让他们连同下面两样一起发给你**：

1. **`replay-bundle-*.json`** — 脚本自动生成
2. **产物文件本身**（PDF / Excel / 图片…）— 脚本会在 console 里打印出需要附带的绝对路径清单

包里有什么（实测验证过）：

| 内容 | 是否可得 | 说明 |
|---|---|---|
| 每轮完整文本 / 推理 | ✅ | 原文，可直接做台词 |
| 每次工具调用的名称 + 完整入参 | ✅ | 直接变成剧本的 `input`，卡片显示一致 |
| 每次工具调用的完整输出 | ✅ | 直接变成 `result.output` |
| 每次回答的**总耗时** | ✅ | `updatedAt − createdAt`，实测与真实值误差 0.6% |
| 模型名 / 权限模式 / MCP 清单 | ✅ | 用于在你这边复现同样配置 |
| **单个工具各自耗时** | ❌ | Cherry 不记录，需要按经验分摊或问对方 |
| 逐 token 的流式节奏 | ❌ | 从未落库 |

也就是说：**内容 100% 还原，总时长精确，只有"这 20 分钟里每一步各占多久"要靠估**。
分摊的经验做法是按工具类型给权重（编译/部署几分钟、查询几秒），总和对齐 bundle 里的 `wallClockMs` 即可。

不含凭证：脚本不读 API Key / provider 地址。但**消息正文会原样带出**，涉密内容请对方自己删改后再发。

> 想要连流式节奏都逐帧还原，只能让对方**用 record 模式重跑一次**（下节），
> 对"已经跑完的历史案例"做不到。

## 录制新剧本

```bash
export REPLAY_UPSTREAM_KEY=<真实KEY>          # 密钥走环境变量，不进命令行
node provider-server.mjs --mode record --upstream https://open.bigmodel.cn/api/anthropic
# Cherry 里把 MCP 参数临时改成 --mode live（真执行并记录耗时/输出）
```

用与演示相同的配置跑一遍成功案例，得到 `recorded/*.request.json`、`recorded/*.frames.ndjson`
和 `scripts/<name>/recorded-tools.ndjson`。目前从录制物整理成 `script.json` 是手工的
（结构一一对应：SSE 帧差 → block 时长，工具日志 → `result`）。

## 机制要点

- **主线识别**：先看请求里**有没有 agent 工具 schema**，再看关键词。标题生成之类的请求
  也包含用户原话，只靠字符串匹配会误判并吃掉一个 turn —— 这是实测过的真实 bug。
- **turn 定位**：按"历史里 assistant 消息条数"索引，工具往返和多轮用户消息都会推进它，
  因此多轮对话天然正确，中途重试也不会错位。
- **工具名绑定**：Cherry 把每个 MCP server 注册进 SDK 时用的是内部 UUID
  （`mcp__<uuid>__bash`）。provider 每个请求都从 `tools[]` 现查现绑，
  所以**改名、删了重加、换 agent 都不影响**；找不到则立即报错（不猜名字），
  并在会话首个请求打印一张绑定表便于现场自检。
- **工具结果匹配**：按 (工具名 + 入参) 匹配，**没有游标、没有状态文件**，
  因此重试幂等、多会话互不干扰，也不需要"演示前 reset"。
- **产物预览**：`report_artifacts` 是 Cherry 内置工具，我们只回放 `tool_use`，
  由 Cherry 真实处理，因此产物是真的注册进对话的。要能点开预览，
  产物必须落在会话工作目录内。
- **排查**：provider 收到的每个请求体存在 `scripts/<name>/.state/requests/`；
  toolbox 日志在 `.state/toolbox.log`；provider 日志见其 stdout。

## 已知边界

- 若演示中途要求"把文件改个名"，当前剧本不会真的改名（固定剧本无此分支）。
  演示前定好文件名即可。
- provider 只监听 `127.0.0.1`。`live` 模式会真实执行命令，仅用于录制，勿在演示机开启。
