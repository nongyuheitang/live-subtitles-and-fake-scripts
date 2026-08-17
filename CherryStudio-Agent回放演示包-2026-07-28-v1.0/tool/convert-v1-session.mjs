#!/usr/bin/env node
/**
 * 把企业版（v1）的一次真实 agent 会话转成回放剧本 script.json。
 *
 * v1 的每个 block 都带 `createdAt`，所以能还原**分步耗时** —— 比 v2 的数据还细
 * （v2 的 parts 没有时间戳，只有整轮总时长）。
 *
 * 用法：
 *   node convert-v1-session.mjs --list
 *   node convert-v1-session.mjs --session <id|标题关键词> --out scripts/<name>
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const args = {}
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i]
  if (a.startsWith('--')) args[a.slice(2)] = process.argv[i + 1]?.startsWith('--') ? true : process.argv[++i]
}

const DB = process.env.V1_DB ?? `${process.env.HOME}/Library/Application Support/CherryStudioEnterprise/Data/agents.db`
const q = (sql) => execFileSync('/usr/bin/sqlite3', [`file:${DB}?mode=ro`, sql], { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 })

if (args.list) {
  console.log(q(`SELECT substr(s.id,1,42)||'  '||COALESCE(s.name,'(无名)')||'  ['||COUNT(m.id)||'条]'
    FROM sessions s LEFT JOIN session_messages m ON m.session_id=s.id
    GROUP BY s.id ORDER BY COUNT(m.id) DESC LIMIT 20;`))
  process.exit(0)
}

const key = args.session
if (!key) { console.error('用法：--session <id|标题关键词> --out scripts/<name>   （或 --list）'); process.exit(1) }
const esc = (s) => String(s).replaceAll("'", "''")
const sid = q(`SELECT id FROM sessions WHERE id='${esc(key)}' OR name LIKE '%${esc(key)}%' LIMIT 1;`).trim()
if (!sid) { console.error(`没找到会话：${key}`); process.exit(1) }
const sname = q(`SELECT COALESCE(name,'') FROM sessions WHERE id='${sid}';`).trim()

// 逐条消息取出（用 \n 分隔的 JSON 行，content 里的换行已被 JSON 转义）
const rows = q(`SELECT role||' '||replace(content, char(10), ' ') FROM session_messages WHERE session_id='${sid}' ORDER BY created_at;`)
  .split('\n').filter(Boolean)
  .map((line) => {
    const sp = line.indexOf(' ')
    const role = line.slice(0, sp)
    try { return { role, j: JSON.parse(line.slice(sp + 1)) } } catch { return null }
  })
  .filter(Boolean)

const toolArgs = (b) => b?.metadata?.rawMcpToolResponse?.arguments ?? {}
const toolOut = (b) => {
  const r = b?.metadata?.rawMcpToolResponse?.response
  if (typeof r === 'string') return r
  if (r?.content?.[0]?.text) return r.content[0].text
  return typeof b?.content === 'string' ? b.content : ''
}

/** 只保留可安全回放的工具；Task 会派生真实子智能体，回放会打乱 turn 计数。 */
const UNSAFE = new Set(['Task', 'Agent'])

/** 把录制机器上的绝对路径改写成本场演示的输出目录，避免真实写到别处。 */
function rewritePaths(value) {
  if (typeof value === 'string') {
    return value.replace(/(?:\/Users\/[^/\s"']+|\/home\/[^/\s"']+|\/tmp)(\/[^\s"']*)?/g, (m, rest) =>
      `{{OUTPUT_DIR}}${rest ? '/' + path.basename(rest) : ''}`
    )
  }
  if (Array.isArray(value)) return value.map(rewritePaths)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, rewritePaths(v)]))
  }
  return value
}

/** v1 把多次 LLM 往返聚合成一条消息；回放必须按工具调用拆回多轮。 */
function splitIntoTurns(blocks) {
  const result = []
  let cur = []
  for (const b of blocks) {
    cur.push(b)
    if (b.type === 'tool_use') { result.push({ blocks: cur, stop: 'tool_use' }); cur = [] }
  }
  if (cur.length) result.push({ blocks: cur, stop: 'end_turn' })
  return result
}

const onlyTurn = args['only-turn'] !== undefined ? Number(args['only-turn']) : undefined
let assistantSeen = -1

const lines = []
const turns = []
for (const { role, j } of rows) {
  const blocks = (j.blocks ?? []).filter((b) => b.type === 'main_text' || b.type === 'tool')
  if (!blocks.length) continue

  if (role === 'user') {
    const t = blocks.find((b) => b.type === 'main_text')
    // 只保留紧挨着被选中回合的那句台词
    if (t?.content && (onlyTurn === undefined || assistantSeen + 1 === onlyTurn)) lines.push(String(t.content))
    continue
  }

  assistantSeen++
  if (onlyTurn !== undefined && assistantSeen !== onlyTurn) continue

  const out = []
  let prevTs = null
  let skipped = 0
  for (const b of blocks) {
    const ts = Date.parse(b.createdAt)
    const gap = prevTs && Number.isFinite(ts) ? Math.max(300, ts - prevTs) : 1500
    if (Number.isFinite(ts)) prevTs = ts

    if (b.type === 'main_text') {
      // 正文里也会出现录制机器的绝对路径（"报告已保存到 /Users/xxx/…"），一并改写，
      // 否则回放时文案指向一个演示机上不存在的位置。
      const text = rewritePaths(String(b.content ?? '').trim())
      if (text) out.push({ type: 'text', durationMs: Math.min(gap, 15000), text })
    } else {
      const name = b.toolName
      if (UNSAFE.has(name)) { skipped++; continue }
      const input = rewritePaths(toolArgs(b))
      const waitMs = Math.min(gap, 60000)
      // Bash：命令换成 sleep（原命令留在注释里，用于命中卡片标签的正则），其余工具原样回放
      const replayInput =
        name === 'Bash'
          ? {
              command: `sleep ${Math.max(1, Math.round(waitMs / 1000))}  # ${String(toolArgs(b).command ?? '').replace(/\s+/g, ' ').slice(0, 90)}`,
              ...(input.description ? { description: input.description } : {})
            }
          : input
      out.push({
        type: 'tool_use',
        tool: name,
        // Bash 的耗时由 sleep 决定；其余工具真执行很快，用流式时长把节奏补回来
        durationMs: name === 'Bash' ? 1200 : Math.max(600, waitMs),
        input: replayInput
      })
    }
  }
  if (skipped) console.error(`  ⚠️  跳过 ${skipped} 个不可回放的工具（Task/Agent 子智能体）`)
  if (out.length) turns.push(...splitIntoTurns(out))
}

// 最后一轮必须以 end_turn 收尾
if (turns.length) turns[turns.length - 1].stop = 'end_turn'

const hint = (lines[0] ?? sname).replace(/\s+/g, ' ').slice(0, 14)
const total = turns.flatMap((t) => t.blocks).reduce((s, b) => s + (b.durationMs ?? 0), 0)

const script = {
  name: args.out ? path.basename(args.out) : 'converted',
  description: `由 v1 会话「${sname}」自动转换`,
  model: 'GLM-5.2',
  match: { anyOf: [hint] },
  textCharsPerFrame: 3,
  lines,
  turns,
  fallbacks: [{ whenBodyContains: 'title', text: sname || '会话' }, { whenBodyContains: '', text: 'OK' }]
}

const outDir = path.resolve(__dirname, args.out ?? 'scripts/converted')
fs.mkdirSync(outDir, { recursive: true })
fs.writeFileSync(path.join(outDir, 'script.json'), JSON.stringify(script, null, 2))

console.log(`✅ ${path.join(outDir, 'script.json')}`)
console.log(`   会话「${sname}」→ ${turns.length} 轮，台词 ${lines.length} 句，估算总时长 ${(total / 60000).toFixed(1)} 分钟`)
console.log(`   匹配关键词：${JSON.stringify(hint)}`)
console.log(`\n台词（按顺序发送）：`)
lines.forEach((l, i) => console.log(`   ${i + 1}. ${l.replace(/\s+/g, ' ').slice(0, 70)}`))
