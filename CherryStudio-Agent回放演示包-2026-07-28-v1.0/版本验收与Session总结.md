# 版本验收与 Session 总结

## 1. 最终结论

本包可作为 Cherry Studio Agent 固定剧本回放的正式演示版 v1.0。

它不是 Cherry Studio Runtime Driver 的源码改造，而是一套独立本地工具：

- Fake Provider 回放模型侧 SSE、文字、思考和工具调用。
- Cherry Studio 原生工具真实执行安全的本地步骤。
- 预先生成并检查过的 PDF/PPTX 在正确时刻复制到工作目录。
- Cherry Studio 原生 `report_artifacts` 注册真实产物并提供右侧预览。

工作区仓库源码没有因为本原型而修改。

## 2. 原始 Claude Session 做了什么

最初方案完成了：

1. 本地 Fake Provider 的 Anthropic/OpenAI 兼容端点。
2. replay/record 两种模式。
3. MCP Toolbox 的 replay/live 两种模式。
4. 固定剧本、模型输出、工具结果和延时回放。
5. PDF 样例资产复制。
6. 会话采集和 v1 数据库转换脚本。

当时未完全解决：

- Cherry Studio 注册 MCP 后，实际工具名可能带内部 UUID，固定工具名会失效。
- 文件虽然落盘，但没有注册为 artifact，无法在对话中点击预览。
- 由命令生成的 PPTX/PDF 在命令被替换为 `sleep` 后不会真实存在。
- 正文文本里的 `{{OUTPUT_DIR}}` 没有展开。

## 3. 后续关键进展

### 3.1 动态工具绑定

Provider 不再依赖固定的 `mcp__toolbox__bash`，而是从每次请求的 `tools[]` 动态查找当前完整工具名。

因此：

- MCP 显示名改变不会直接破坏剧本。
- 删除重加导致 UUID 变化后仍可重新绑定。
- 换 Agent 后会按新请求的工具 schema 重新解析。
- 找不到工具时明确报错，不猜测旧名字。

### 3.2 PDF artifact 与预览

PDF 在工作目录内真实落盘后，由 Cherry Studio 原生 `report_artifacts` 注册。

结果：

- 对话出现真实产物。
- 点击后右侧打开 PDF 预览。
- 历史问题“只有加粗文件名、没有超链接”得到解决。

### 3.3 PPTX 真实资产

转换器会把 Bash 命令替换为延时，所以 `node generate-ppt-simple.js` 并没有真正执行。修复方式是：

1. 在隔离目录安装 `pptxgenjs`。
2. 真实运行一次生成脚本。
3. 检查生成的 7 页 PPTX。
4. 将 `184,745 bytes` 的文件放入 `assets/`。
5. 回放时执行 `cp 真实资产 && sleep 52`。

这样产物会在正确阶段真实出现，且不需要回放时安装依赖或运行复杂生成命令。

### 3.4 文本变量展开

Provider 原先只对工具入参执行变量展开，导致最终正文仍显示字面量 `{{OUTPUT_DIR}}`。

当前版本会同时展开：

- 工具参数里的 `{{OUTPUT_DIR}}` / `{{SCRIPT_DIR}}`。
- 普通文本块里的相同变量。

最终正文会显示真实绝对路径。

### 3.5 SDK 命令护栏约束

微型探针确认：

```text
sleep N && <命令>
```

会被 claude-agent-sdk 识别并阻止。正式包统一采用：

```text
cp ... && sleep N
```

先完成安全文件复制，再等待原录制时长。

## 4. 最终端到端验收

PPTX 全流程：

- 开始：2026-07-28 20:28:21。
- 主回放结束：2026-07-28 20:39:46。
- UI：`Processed · 11m 25s`。
- Provider：turn 0 至 turn 47 全部下发。
- 产物：`CherryStudio-Introduction.pptx`。
- 大小：`184,745 bytes`。
- ZIP 结构检查：通过。
- 右侧预览：7/7 页。
- 关键页：`Use Cases`、`Edition Comparison`、`Get Started with CherryStudio`。
- `File unavailable`：未出现。
- 正文变量占位符：未出现。

PDF：

- 真实 4 页 A4 文件。
- 使用文档示例地址 `203.0.113.10`。
- 原服务器地址和凭据未进入正式包。
- 第 3 页原有裁切问题已在打包资产中修正。
- 右侧 artifact 预览链路已验证。

## 5. “零报错”的准确口径

可以确认的是：48 个主回放 turn 全部正常送达，最终产物和 UI 完整呈现。

不能把它描述成所有日志绝对没有 warning/error：

- 原始 PPT 剧本保留了若干探索过程中的工具失败结果。
- 主回放完成后，Cherry Studio 的 Topic Naming 可能产生不影响结果的 API 告警。
- 开发实例还可能提示未安装可选 RTK 插件。

这些不影响最终 PPTX、PDF 和 artifact，但公开描述建议使用：

> 48 轮主回放全部完成，产物生成与预览成功。

## 6. 正式版边界

正式版的含义是“两套固定案例可稳定回放并展示真实产物”，不是：

- 任意话术都能回复。
- 任意中途改名都能处理。
- 任意录制数据无需整理即可直接播放。
- replay 模式可替代真实模型或真实运维。

对固定演示而言，文件名应在制作剧本前确定。如果未来需要现场自然语言改名，应增加明确的状态机、受限 rename 工具和 artifact 元数据同步。

## 7. 本次打包处理

正式包：

- 包含 Provider、Toolbox、采集/转换脚本、PDF/PPTX 两套正式案例和完整文档。
- 不包含 `node_modules`、`.state`、请求快照、运行日志或演示输出。
- 将服务器案例替换为 RFC 文档示例地址和纯演示账号。
- 重新生成并逐页检查脱敏 PDF。
- 修正 PPTX 正文中的文件大小说明。
- 生成全包 SHA-256 校验清单。

工作区中的原始文件保持不变。
