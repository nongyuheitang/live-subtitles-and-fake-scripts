/**
 * 采集脚本 —— 交给"跑出了真实成功案例"的同事，让他们把那次会话打包给你。
 *
 * 用法（对方操作，30 秒）：
 *   1. 在 Cherry Studio 里打开那次成功的 agent 会话
 *   2. 菜单 View → Toggle Developer Tools（或 ⌥⌘I），切到 Console
 *   3. 把本文件全部内容粘贴进去回车
 *   4. 会自动下载一个 replay-bundle-<时间>.json —— 连同"产物文件"一起发给你
 *
 * 采集内容：会话里每条消息的完整 parts（文本 / 推理 / 工具名+入参+输出）、
 * 每条消息的 createdAt（用于还原每一步真实耗时）、stats（首字/总时长）、
 * 模型与 agent 配置、以及 report_artifacts 声明过的产物路径清单。
 *
 * 不采集：API Key、provider 地址等凭证（脚本不读这些字段）。
 * 注意：消息正文会原样带出，涉密内容请对方自行删改后再发。
 */
;(async () => {
  const api = window.api?.dataApi
  if (!api) return console.error('[collect] 没找到 window.api.dataApi —— 请确认这是 Cherry Studio 的窗口')

  const req = async (method, path, query) => {
    const r = await api.request({ method, path, ...(query ? { query } : {}) })
    return r?.data
  }

  // ── 1. 定位会话 ────────────────────────────────────────────────
  const sessionsPage = await req('GET', '/agent-sessions')
  const sessions = sessionsPage?.items ?? sessionsPage ?? []
  if (!sessions.length) return console.error('[collect] 这个 Cherry Studio 里没有 agent 会话')

  // 默认取最近更新的一个；要指定别的会话，把它的 id 填到下面这一行
  const SESSION_ID = '' // ← 留空 = 自动选最近的一个
  const session =
    (SESSION_ID && sessions.find((s) => s.id === SESSION_ID)) ||
    [...sessions].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))[0]

  console.log(`[collect] 会话：${session.name || '(未命名)'}  id=${session.id}`)
  if (!SESSION_ID && sessions.length > 1) {
    console.log('[collect] 如果不是这一个，把下面某个 id 填进脚本里的 SESSION_ID 再跑一次：')
    console.table(sessions.map((s) => ({ id: s.id, name: s.name, updatedAt: s.updatedAt })))
  }

  // ── 2. 翻页取全部消息（接口是"从新到旧"游标分页）────────────────
  const messages = []
  let cursor
  for (let page = 0; page < 100; page++) {
    const res = await req('GET', `/agent-sessions/${session.id}/messages`, { limit: 200, ...(cursor ? { cursor } : {}) })
    const items = res?.items ?? []
    messages.push(...items)
    cursor = res?.nextCursor
    if (!cursor || !items.length) break
  }
  // 接口返回是"从新到旧"，按 createdAt 正序排回时间线
  messages.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
  console.log(`[collect] 取到 ${messages.length} 条消息`)

  // ── 3. 精简成回放需要的结构 ────────────────────────────────────
  const artifactPaths = new Set()
  const toShortToolName = (n) => String(n ?? '').replace(/^mcp__.+?__/, '')

  const turns = messages.map((m) => {
    const blocks = (m.data?.parts ?? [])
      .map((p) => {
        const t = p.type ?? ''
        if (t === 'text') return { type: 'text', text: p.text ?? '' }
        if (t === 'reasoning') return { type: 'thinking', text: p.text ?? '' }
        if (t.startsWith('tool-') || t === 'dynamic-tool') {
          const name = toShortToolName(p.toolName ?? t.replace(/^tool-/, ''))
          if (name === 'report_artifacts') {
            for (const a of p.input?.artifacts ?? []) if (a?.path) artifactPaths.add(a.path)
          }
          return {
            type: 'tool_use',
            tool: name,
            input: p.input ?? {},
            output: typeof p.output === 'string' ? p.output : (p.output ?? null),
            state: p.state ?? null
          }
        }
        return null
      })
      .filter(Boolean)

    return {
      role: m.role,
      // assistant 行的 updatedAt−createdAt = 这一次回答的完整墙钟耗时（含全部工具执行）。
      // user 行是瞬时写入，恒为 0。
      wallClockMs: Date.parse(m.updatedAt) - Date.parse(m.createdAt),
      createdAt: m.createdAt,
      stats: m.stats ?? null, // timeFirstTokenMs / timeCompletionMs / timeThinkingMs
      modelId: m.modelId ?? null,
      blocks
    }
  })

  // ── 4. agent 与 MCP 配置（不含任何密钥）─────────────────────────
  let agent = null
  let mcpNames = []
  try {
    const agentsPage = await req('GET', '/agents')
    const agents = agentsPage?.items ?? agentsPage ?? []
    const a = agents.find((x) => x.id === session.agentId)
    if (a) {
      agent = {
        type: a.type,
        model: a.model,
        planModel: a.planModel,
        smallModel: a.smallModel,
        permissionMode: a.configuration?.permission_mode ?? null,
        instructions: a.instructions ?? null
      }
    }
    const mcpPage = await req('GET', '/mcp-servers')
    mcpNames = (mcpPage?.items ?? mcpPage ?? []).map((s) => ({ name: s.name, type: s.type, timeout: s.timeout ?? null }))
  } catch (e) {
    console.warn('[collect] agent/MCP 配置读取失败（不影响主体）', e?.message)
  }

  const bundle = {
    collectedAt: new Date().toISOString(),
    appVersion: (await req('GET', '/app/info').catch(() => null))?.version ?? null,
    session: { id: session.id, name: session.name, createdAt: session.createdAt, updatedAt: session.updatedAt },
    agent,
    mcpServers: mcpNames,
    totalWallClockMs: turns.reduce((s, t) => s + (t.wallClockMs || 0), 0),
    artifactPaths: [...artifactPaths],
    turns
  }

  // ── 5. 下载 ───────────────────────────────────────────────────
  const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `replay-bundle-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
  document.body.appendChild(a)
  a.click()
  a.remove()

  console.log(
    `[collect] ✅ 已下载 ${a.download}\n` +
      `    消息 ${turns.length} 条，总耗时 ${(bundle.totalWallClockMs / 1000).toFixed(1)} 秒\n` +
      (bundle.artifactPaths.length
        ? `    请把这些产物文件一并发过来：\n${bundle.artifactPaths.map((p) => '      ' + p).join('\n')}`
        : '    （这次会话没有声明产物文件）')
  )
  return bundle
})()
