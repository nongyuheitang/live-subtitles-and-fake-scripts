# 内置工具卡片标签速查表

回放时若想让工具卡片与真实运行**完全一致**，就用**内置工具裸名**（`Bash` / `Write` / `Read` / `Glob` / `Grep` / `Edit` …）而不是 MCP 替身工具。

## 卡片是怎么算出来的

`src/renderer/components/chat/messages/tools/ToolHeader.tsx:271`

```js
const text = `${description ?? ''} ${command ?? ''}`.toLowerCase()
// 自上而下匹配，第一个命中的决定标签
```

折叠态卡片显示 **`<动作> <宾语>`**，两者都由上式的 `text` 决定 —— **与是否真执行、输出是什么完全无关**。
所以只要 `description` + `command` 里出现对应关键词，就能拿到想要的标签，而 `command` 本身可以是无害的 `sleep N`。

> 运行中显示"进行时"文案（`正在保存`/`耐心查找`…），结束后显示完成态（`保存`/`查找`…）。
> 演示时观众看到的是运行中状态 —— 与真实运行一致。

## 关键词 → 标签对照（Bash 工具）

按源码顺序，**先命中先生效**：

| 命令里出现 | 动作 | 宾语 |
|---|---|---|
| `npm/pnpm/yarn/bun/pip/poetry/uv/cargo/go/brew` + `install/add/get` | 安装 | 项目依赖 |
| 同上 + `remove/uninstall/rm` | 删除 | 项目依赖 |
| 同上 + `list/ls/outdated/update/upgrade` | 查看 | 项目依赖 |
| `curl` / `wget` | 下载 | （自动识别目标） |
| `git clone` | 下载 | 项目内容 |
| `git pull/fetch/rebase/merge` | 同步 | 项目内容 |
| `git checkout/switch/branch` | 切换 | 项目版本 |
| `git status/diff/log/show/blame` | 查看 | 项目改动 |
| `git commit` | 保存 | 项目改动 |
| `git push` | 上传 | 项目改动 |
| `gh api/auth/pr/issue/run/workflow/repo` | 查看 | 远程仓库信息 |
| `cp` / `rsync` | 复制 | （命令里的路径） |
| `mv` | 移动 | （路径） |
| `rm` / `rmdir` | 删除 | （路径） |
| `mkdir` | 新建 | 文件夹 |
| `touch` | 新建 | （路径） |
| `unzip` / `tar` | 解压 | 压缩包 |
| `npm/pnpm/yarn/bun run dev/start/serve`、`docker compose up` | 启动 | 项目任务 |
| `open` / `xdg-open` | 打开 | （路径） |
| `npm run build`、`vite build`、`webpack`、`electron-builder` | 构建 | 项目文件 |
| `test` / `lint` / `typecheck` / `vitest` / `jest` / `tsc` / `eslint` | 检查 | 项目检查 |
| **`rg` / `grep` / `ag` / `fd` / `find` / `locate`** | **查找** | **← 取自 `description`** |
| `pwd` | 查看 | 当前文件夹 |
| **`cd`** | **切换** | **文件夹** |
| `env` / `printenv` / `uname` / `sw_vers` / `which` / `--version` | 查看 | 运行环境 |
| `cat` / `head` / `tail` / `less` / `sed -n` / `awk` / `wc` / `stat` / `du` | 查看 | （命令里的路径） |
| `ls` / `tree` / `list` | 查看 | 文件列表 |
| **（都不匹配）** | **执行** | **项目任务** |

只有 `find/grep` 这一档的宾语来自 `description`，其余都是固定词。想让卡片显示自定义中文，就走这一档。

## 写法配方

```json
{
  "type": "tool_use", "tool": "Bash", "durationMs": 900,
  "input": {
    "command": "sleep 12  # grep 收集更详细的服务器信息",
    "description": "收集更详细的服务器信息"
  }
}
```

→ 卡片显示 **「查找 收集更详细的服务器信息」**；实际只执行 `sleep 12`（`#` 之后是注释），零副作用，耗时精确。

要点：
- **`sleep N` 决定耗时**，N 与录制值一致即可
- **`# 关键词` 决定标签**，把想命中的关键词放进注释
- **`description` 原样抄录制值**

## 各内置工具的注意事项

| 工具 | 真实执行行为 | 回放建议 |
|---|---|---|
| `Bash` | 真跑命令 | `sleep N # 关键词`，安全可控 |
| `Write` | **真写文件** | 正好用来生成产物（文本类）；二进制产物改用 `Bash` + `cp` |
| `Read` / `Glob` / `Grep` | 真读，只读无害 | 让它真跑；或改成 `Bash` 模拟 |
| `TodoWrite` | 纯声明，无副作用 | **不会内联渲染**（`AgentExecutionTimeline` 里硬编码 `return null`），由右侧状态面板消费——真实运行也如此，不算差异 |
| `Task` | 会真的派生子智能体 | 子智能体也会打到我们的假 provider，turn 计数会乱，**暂不建议回放** |
| `AskUserQuestion` | 弹交互问答 | 可回放，演示时现场点选，是加分项 |

## 一个容易误判的现象

回合结束后，Cherry 会把整段过程（思考 + 工具调用 + 中间文本）折叠成一行 **`Processed · Xs`**。
这是 V2 的正常行为，**真实运行同样如此**。演示时观众看到的是运行中的展开状态，不受影响；
事后回看要点开那一行才能看到卡片。
