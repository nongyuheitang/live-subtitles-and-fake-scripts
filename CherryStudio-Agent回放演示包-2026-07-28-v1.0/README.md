# Cherry Studio Agent 回放演示包 v1.0

这是已经完成端到端验收的本地回放演示包。它通过 Fake Provider 按固定剧本回放模型输出，再由 Cherry Studio 的原生 Agent 工具执行安全的本地文件操作，最终把 PDF 或 PPTX 注册为可点击、可预览的对话产物。

本包没有修改 Cherry Studio 源码，也不会在 replay 模式下访问真实模型服务或 SSH 服务器。

## 1. 当前状态

| 项目 | 状态 |
| --- | --- |
| Fake Provider | 已验证 |
| MCP 工具 UUID 动态绑定 | 已验证 |
| PDF 真实落盘与右侧预览 | 已验证 |
| PPTX 真实落盘与右侧预览 | 已验证，7/7 页 |
| 正文路径变量展开 | 已验证 |
| 产物不存在 / `File unavailable` | 已修复 |
| 多会话并行回放 | 支持无游标匹配，但正式演示仍建议一场一会话 |
| 临时自然语言改文件名 | 不支持，属于固定剧本边界 |

PPTX 正式验收结果：

- 48 个回放 turn 全部送达。
- Cherry Studio 显示 `Processed · 11m 25s`。
- 产物为 `CherryStudio-Introduction.pptx`，大小 `184,745 bytes`。
- 右侧成功渲染 7 页真实幻灯片。
- 正文显示真实绝对路径，不含 `{{OUTPUT_DIR}}`。
- 没有出现 `File unavailable`。

## 2. 包目录

```text
CherryStudio-Agent回放演示包-2026-07-28-v1.0/
├── README.md
├── 版本验收与Session总结.md
├── 后续优化建议.md
├── SHA256SUMS.txt
├── docs/
│   └── 技术README.md
├── tool/
│   ├── provider-server.mjs
│   ├── mcp-toolbox.mjs
│   ├── collect-session.js
│   ├── cherry-collect.sh
│   ├── convert-v1-session.mjs
│   └── TOOL-CARD-LABELS.md
└── examples/
    ├── ppt-demo/
    │   ├── script.json
    │   ├── assets/
    │   │   └── CherryStudio-Introduction.pptx
    │   └── seed/
    │       ├── README.md
    │       └── package.json
    └── server-inspection-native/
        ├── script.json
        └── assets/
            └── 服务器情况报告_203.0.113.10.pdf
```

压缩包不包含 `node_modules`、`.state`、请求快照、运行日志或本机输出目录。

## 3. 工作原理

```text
用户发送固定话术
    ↓
Cherry Studio Agent / Claude Agent SDK
    ↓
本地 provider-server.mjs
    ↓ 回放流式文字、思考块和工具调用
Cherry Studio 原生工具
    ↓ 执行 Write / Edit / Read / Bash 等安全本地步骤
预先生成的真实 PDF/PPTX 在指定时刻复制到工作目录
    ↓
Cherry Studio 原生 report_artifacts
    ↓
右侧出现可点击、可预览的真实产物
```

关键实现约束：

1. 剧本中的逻辑工具名会根据每次请求的 `tools[]` 动态绑定到 Cherry Studio 当前注册的完整工具名，避免 MCP 名称或内部 UUID 变化导致失败。
2. `{{OUTPUT_DIR}}` 和 `{{SCRIPT_DIR}}` 会同时在工具参数与正文文本中展开。
3. 命令生成的二进制产物必须提前真生成一次并放入 `assets/`。
4. 复制产物的命令必须写成 `cp ... && sleep N`，不能写成 `sleep N && cp ...`。
5. `report_artifacts` 不由 Fake Provider 假执行，而是交给 Cherry Studio 原生工具真实注册。

## 4. 环境要求

- macOS。
- 可运行 Agent、自定义 Anthropic Provider 和本地工具的 Cherry Studio v2 开发版或对应正式版本。
- Node.js 18 或更高版本；本包最终校验使用 Node.js 26。
- 本机端口 `8402` 可用。
- 演示输出目录必须同时设置为当前 Agent 会话工作目录。

检查 Node：

```bash
node --version
```

## 5. 第一次配置 Cherry Studio

### 5.1 添加本地 Provider

在 Cherry Studio 的模型服务中添加自定义 Provider：

- Provider 类型：Anthropic。
- API 地址：`http://127.0.0.1:8402`
- API Key：填写演示占位值，例如 `sk-demo`。
- 模型 ID：`GLM-5.2`

如果 Agent 有主模型、计划模型、小模型等多个模型槽位，全部选择这个本地 Provider 下的 `GLM-5.2`。这样标题或辅助请求不会绕到真实 Provider。

### 5.2 配置演示 Agent

- 主模型、计划模型、小模型全部选择本地 `GLM-5.2`。
- 权限模式选择 `Full Auto Mode`，否则长剧本会反复弹审批。
- PPTX 案例需要启用 Cherry Studio 提供的 `Read`、`Write`、`Edit`、`Bash` 和 artifact 相关原生工具。
- PDF 案例需要启用 `Bash` 和 artifact 相关原生工具。
- 两套正式案例都不需要挂载 `mcp-toolbox.mjs`。

`mcp-toolbox.mjs` 保留在包内，主要用于旧剧本兼容、录制和后续扩展。

## 6. 运行 PPTX 正式演示

### 6.1 设置路径

在终端执行：

```bash
PACKAGE_DIR="/Users/cherryai/Downloads/CherryStudio-Agent回放演示包-2026-07-28-v1.0"
OUTPUT_DIR="/Users/cherryai/Desktop/replay-demo-out"
mkdir -p "$OUTPUT_DIR"
```

建议演示前确认输出目录里没有旧的同名文件。

### 6.2 启动 Provider

```bash
node "$PACKAGE_DIR/tool/provider-server.mjs" \
  --script "$PACKAGE_DIR/examples/ppt-demo" \
  --out-dir "$OUTPUT_DIR" \
  --port 8402
```

看到以下日志表示启动成功：

```text
mode=replay listening on http://127.0.0.1:8402
```

可另开终端检查：

```bash
curl http://127.0.0.1:8402/v1/models
```

### 6.3 在 Cherry Studio 中运行

1. 使用演示 Agent 新建一个全新会话。
2. 把会话工作目录设置为：

   ```text
   /Users/cherryai/Desktop/replay-demo-out
   ```

3. 确认模型为本地 `GLM-5.2`。
4. 发送：

   ```text
   CherryStudio 产品介绍
   ```

5. 等待流程结束，不要在中途发送其他消息。

### 6.4 验收

应看到：

- `Processed · 11m 25s` 左右的总耗时。
- 正文链接指向真实的 `CherryStudio-Introduction.pptx`。
- 右侧预览显示 `7 / 7`。
- 幻灯片包含 `Use Cases`、`Edition Comparison` 和 `Get Started with CherryStudio`。

磁盘文件：

```text
/Users/cherryai/Desktop/replay-demo-out/CherryStudio-Introduction.pptx
```

## 7. 运行 PDF 正式演示

PPTX Provider 停止后，在原终端按 `Control-C`，再启动 PDF 剧本：

```bash
PACKAGE_DIR="/Users/cherryai/Downloads/CherryStudio-Agent回放演示包-2026-07-28-v1.0"
OUTPUT_DIR="/Users/cherryai/Desktop/replay-demo-out"

node "$PACKAGE_DIR/tool/provider-server.mjs" \
  --script "$PACKAGE_DIR/examples/server-inspection-native" \
  --out-dir "$OUTPUT_DIR" \
  --port 8402
```

在 Cherry Studio 新建另一个全新会话，工作目录仍设为 `OUTPUT_DIR`，依次发送两句话。

第一句：

```text
203.0.113.10
用户名: demo
密码：demo-only-not-real
```

第二句：

```text
帮我做一次完整的服务器巡检，输出 PDF 报告
```

说明：

- `203.0.113.10` 属于文档示例地址，不是真实服务器。
- replay 模式不会发起 SSH 连接。
- 产物是预先生成的脱敏演示报告。

预期结果：

- 文件 `服务器情况报告_203.0.113.10.pdf` 真实落盘。
- 对话中出现 artifact。
- 点击后在 Cherry Studio 右侧打开 4 页 PDF。
- PDF 的“服务与容器”“网络与安全”“安全基线”等表格应完整显示。

## 8. 为什么产物必须提前真生成

转换器会把录制时的危险或昂贵命令替换为安全延时。如果原命令负责生成 PPTX、PDF、ZIP 或图片，仅回放 `sleep` 不会产生文件，最终 artifact 会显示 `File unavailable`。

正式流程是：

1. 在隔离环境中真实运行生成脚本。
2. 打开并检查产物。
3. 把确认过的二进制文件放入案例的 `assets/`。
4. 在回放的“生成完成”步骤先复制资产，再等待原始耗时：

   ```bash
   cp "{{SCRIPT_DIR}}/assets/result.pptx" "{{OUTPUT_DIR}}/" && sleep 52
   ```

文本文件如果由 `Write` 工具直接生成，则不需要预先放进 `assets/`。

## 9. 收集和转换新会话

### 9.1 从 Cherry Studio v2 收集

`tool/collect-session.js` 用于在 Cherry Studio DevTools Console 中采集当前成功会话。它会导出消息、工具调用、时间信息和 artifact 路径，不读取 API Key，但会原样包含对话正文。

### 9.2 本地数据库打包

```bash
bash "$PACKAGE_DIR/tool/cherry-collect.sh" --list
bash "$PACKAGE_DIR/tool/cherry-collect.sh" "会话标题关键词"
```

该脚本只读访问本地 SQLite 数据库，并使用系统 `zip` 生成采集包。

### 9.3 转换 v1 会话

```bash
node "$PACKAGE_DIR/tool/convert-v1-session.mjs" --list
node "$PACKAGE_DIR/tool/convert-v1-session.mjs" \
  --session "标题关键词" \
  --out "$PACKAGE_DIR/examples/new-demo"
```

转换后仍需人工完成：

- 绝对路径脱敏和变量化。
- 工具名与 tool result 对齐。
- 命令生成产物的预生成和资产复制。
- `report_artifacts` 注册步骤。
- 全流程端到端验收。

## 10. 常见问题

### Provider 启动后剧本不播放

- 确认发送的话术与 `script.json` 的 `match.anyOf` 匹配。
- 确认所有 Agent 模型槽位都选择了本地 `GLM-5.2`。
- 确认使用全新会话。
- 查看 Provider 终端是否输出 `turn 0`。

### 出现 `No such tool available`

- 确认 Agent 启用了剧本需要的工具。
- 查看 Provider 首个 Agent 请求打印的工具绑定表。
- 若某个逻辑工具显示 `NOT REGISTERED`，先修 Agent 工具配置，再新开会话。

标题生成等 utility 请求没有 Agent 工具 schema，日志里显示 `NOT REGISTERED` 属正常现象；主回放请求会重新绑定。

### 文件已经生成，但不能预览

- 确认文件位于当前会话工作目录内。
- 确认 `report_artifacts` 已执行成功。
- 确认正文和 artifact 使用的是展开后的真实路径。
- 确认文件名大小写、空格和扩展名完全一致。

### 出现 `Blocked: sleep N followed by`

把命令从：

```bash
sleep 10 && cp source target
```

改为：

```bash
cp source target && sleep 10
```

### PPTX 正文仍显示 `{{OUTPUT_DIR}}`

确认使用的是本包的 `tool/provider-server.mjs`，不要混用旧版 Provider。

### 会话标题生成失败

主回放完成后可能出现不影响产物的 Topic Naming 告警。它不会改变对话正文、工具过程或 artifact；正式演示时可提前手动设置会话标题。

## 11. 已知边界

- 这是固定剧本回放系统，不是可自由回答任意问题的通用模型。
- 演示中临时要求改文件名不会自动进入新分支。
- 对已录制的失败探索步骤，回放会忠实保留；用于公开演示时应选择干净成功的录制。
- PPTX 案例较长，电脑负载、SDK 调度和渲染会让总耗时有少量变化。
- record/live 模式会访问真实上游或执行真实命令，不应在公开演示时启用。

## 12. 安全要求

- 正式演示只使用默认 replay 模式。
- Provider 只监听 `127.0.0.1`。
- 不要把真实 API Key、Cookie、服务器地址、客户数据或 SSH 凭据写入剧本。
- 分享新录制包前，必须检查对话正文、工具参数、工具输出、文件名和产物内容。
- 上游 Key 只允许通过 `REPLAY_UPSTREAM_KEY` 环境变量传入。
- 不要把 `.state/requests` 或 toolbox 日志放进分发包。

## 13. 校验包完整性

在解压后的包根目录执行：

```bash
shasum -a 256 -c SHA256SUMS.txt
```

所有条目都应显示 `OK`。

进一步检查：

```bash
node --check tool/provider-server.mjs
node --check tool/mcp-toolbox.mjs
jq empty examples/ppt-demo/script.json
jq empty examples/server-inspection-native/script.json
unzip -t examples/ppt-demo/assets/CherryStudio-Introduction.pptx
pdfinfo examples/server-inspection-native/assets/服务器情况报告_203.0.113.10.pdf
```

更底层的录制、剧本结构和工具卡片说明见：

- `docs/技术README.md`
- `tool/TOOL-CARD-LABELS.md`
- `后续优化建议.md`
