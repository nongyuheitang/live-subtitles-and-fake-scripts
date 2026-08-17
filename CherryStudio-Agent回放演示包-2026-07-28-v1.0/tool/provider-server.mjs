#!/usr/bin/env node
/**
 * Fake LLM provider server for demo replay.
 *
 * Modes:
 *   replay (default): serve scripted SSE responses from a script directory.
 *   record          : transparent proxy to a real upstream, dumping request/SSE frames to ./recorded.
 *
 * Endpoints:
 *   POST /v1/messages              Anthropic Messages (SSE)   <- claude-agent-sdk direct route
 *   POST /v1/messages/count_tokens Anthropic token count stub
 *   POST /v1/chat/completions      OpenAI Chat (SSE)          <- Cherry gateway route fallback
 *   GET  /v1/models                model list (both dialects)
 *
 * Usage:
 *   node provider-server.mjs --script scripts/server-inspection --out-dir ~/Desktop/demo-out [--port 8402]
 *   node provider-server.mjs --mode record --upstream https://open.bigmodel.cn/api/anthropic [--port 8402]
 *     (record reads the upstream key from env REPLAY_UPSTREAM_KEY)
 */
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// ---------- args ----------
const args = {}
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i]
  if (a.startsWith('--')) args[a.slice(2)] = process.argv[i + 1]?.startsWith('--') ? true : process.argv[++i]
}
const MODE = args.mode ?? 'replay'
const PORT = Number(args.port ?? 8402)
const SCRIPT_DIR = args.script ? path.resolve(__dirname, args.script) : path.join(__dirname, 'scripts/server-inspection')
const OUT_DIR = path.resolve(args['out-dir'] ?? path.join(SCRIPT_DIR, 'out'))
const UPSTREAM = args.upstream?.replace(/\/$/, '')
const UPSTREAM_KEY = process.env.REPLAY_UPSTREAM_KEY

const log = (...xs) => console.error(`[provider ${new Date().toISOString().slice(11, 19)}]`, ...xs)

// ---------- script loading (replay mode) ----------
let script = null
if (MODE === 'replay') {
  script = JSON.parse(fs.readFileSync(path.join(SCRIPT_DIR, 'script.json'), 'utf8'))
  log(`script "${script.name}" — ${script.turns.length} turns, match=${JSON.stringify(script.match.anyOf)}`)
  log(`output dir: ${OUT_DIR}`)
}
const STATE_DIR = path.join(SCRIPT_DIR, '.state')
fs.mkdirSync(path.join(STATE_DIR, 'requests'), { recursive: true })
let reqSeq = 0

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const rid = (p) => p + Math.random().toString(36).slice(2, 10)

/** Expand `{{OUTPUT_DIR}}` (and friends) inside any scripted tool input. */
function expandVars(value) {
  if (typeof value === 'string') return value.replaceAll('{{OUTPUT_DIR}}', OUT_DIR).replaceAll('{{SCRIPT_DIR}}', SCRIPT_DIR)
  if (Array.isArray(value)) return value.map(expandVars)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, expandVars(v)]))
  }
  return value
}

/** Split text into frames of ~n chars without breaking surrogate pairs. */
function chunkText(text, n) {
  const out = []
  for (const seg of text) {
    if (!out.length || out[out.length - 1].length >= n) out.push('')
    out[out.length - 1] += seg
  }
  return out.filter((s) => s.length)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const bufs = []
    req.on('data', (c) => bufs.push(c))
    req.on('end', () => resolve(Buffer.concat(bufs).toString('utf8')))
    req.on('error', reject)
  })
}

function sseHead(res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-request-id': rid('req_')
  })
}

// ---------- replay: request classification ----------
/**
 * Only a real agent turn carries the agent tool schema. Title generation, summarization and
 * other utility calls embed the user's own words — so a bare string match on the body would
 * misclassify them as main-line and burn a scripted turn. Require tools[] first.
 */
function isMainLineRequest(body, bodyStr) {
  const toolCount = (body.tools ?? []).length
  if (toolCount === 0) return { main: false, why: 'no tool schema (utility request)' }
  const hint = (script.match?.anyOf ?? []).find((h) => bodyStr.includes(h))
  if (!hint) return { main: false, why: 'no match hint in body' }
  return { main: true, why: `hint "${hint}" + ${toolCount} tools` }
}

function pickFallback(bodyStr) {
  for (const f of script.fallbacks ?? []) {
    if (!f.whenBodyContains || bodyStr.includes(f.whenBodyContains)) return f
  }
  return { text: 'OK' }
}

/** Resolve what to play for this request: a scripted turn, or a fallback text. */
function resolvePlan(body, bodyStr) {
  const verdict = isMainLineRequest(body, bodyStr)
  if (!verdict.main) {
    const f = pickFallback(bodyStr)
    return { blocks: [{ type: 'text', text: f.text, durationMs: 150 }], stop: 'end_turn', label: `fallback (${verdict.why})` }
  }
  // Turn index = how many assistant messages the transcript already holds. Tool round-trips and
  // extra user messages both advance it, so multi-turn conversations index correctly.
  const idx = (body.messages ?? []).filter((m) => m.role === 'assistant').length
  const turn = script.turns[idx]
  if (!turn) {
    return {
      blocks: [{ type: 'text', text: '（演示剧本已播放完毕，请新开会话重新开始。）', durationMs: 300 }],
      stop: 'end_turn',
      label: `overrun — turn ${idx} not in script`
    }
  }
  return { blocks: turn.blocks, stop: turn.stop ?? 'end_turn', label: `turn ${idx}` }
}

// ---------- replay: tool name binding ----------
/**
 * Cherry registers each MCP server into the SDK under an internal UUID, so the wire name is
 * `mcp__<uuid>__bash`, never `mcp__toolbox__bash`. Bind logical names from the request's own
 * tools[] on every call — that makes renaming the MCP server, re-adding it, or a UUID change
 * a non-event. Fail closed when a scripted tool is absent: a guessed name would surface as
 * "No such tool available" mid-demo.
 */
/** Claude Code builtin tools — bare wire names that map to Cherry's native tool cards. */
const BUILTIN_TOOL_NAMES = new Set([
  'Bash', 'BashOutput', 'Read', 'Write', 'Edit', 'MultiEdit', 'Glob', 'Grep', 'Search',
  'TodoWrite', 'Task', 'TaskOutput', 'TaskStop', 'TaskCreate', 'TaskGet', 'TaskUpdate', 'TaskList',
  'WebSearch', 'WebFetch', 'NotebookEdit', 'ExitPlanMode', 'Skill', 'ToolSearch',
  'AskUserQuestion', 'ListMcpResources', 'ReadMcpResource'
])

function buildToolNameMap(bodyTools) {
  const map = {}
  for (const t of bodyTools ?? []) {
    const name = t?.name ?? t?.function?.name
    const m = /^mcp__(.+)__([A-Za-z0-9_-]+)$/.exec(name ?? '')
    if (m && !(m[2] in map)) map[m[2]] = name
  }
  return map
}

let loggedBinding = false
function resolveToolName(shortName, map, planLabel) {
  // Builtin SDK tools (Bash / Read / Write / TodoWrite / …) travel under their bare name — that
  // exact string is what selects the native tool card in the renderer, so pass it through
  // untouched. They really execute, so a script must keep their input harmless (see README).
  if (BUILTIN_TOOL_NAMES.has(shortName)) return shortName
  const full = map[shortName]
  if (!full) {
    const available = Object.keys(map).sort().join(', ') || '(none)'
    throw new Error(
      `scripted tool "${shortName}" is not registered in this request (${planLabel}). ` +
        `Available: ${available}. Check the MCP server is enabled on this agent.`
    )
  }
  return full
}

// ---------- replay: Anthropic SSE ----------
async function playAnthropic(res, plan, model, toolMap) {
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  let outTokens = 0
  send('message_start', {
    type: 'message_start',
    message: {
      id: rid('msg_'), type: 'message', role: 'assistant', content: [], model,
      stop_reason: null, stop_sequence: null,
      usage: { input_tokens: 2048, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
    }
  })
  let index = 0
  for (const block of plan.blocks) {
    const dur = Math.max(50, block.durationMs ?? 1000)
    if (block.type === 'text' || block.type === 'thinking') {
      const isThink = block.type === 'thinking'
      send('content_block_start', {
        type: 'content_block_start', index,
        content_block: isThink ? { type: 'thinking', thinking: '' } : { type: 'text', text: '' }
      })
      const frames = chunkText(expandVars(block.text), script.textCharsPerFrame ?? 3)
      const gap = dur / Math.max(1, frames.length)
      for (const f of frames) {
        send('content_block_delta', {
          type: 'content_block_delta', index,
          delta: isThink ? { type: 'thinking_delta', thinking: f } : { type: 'text_delta', text: f }
        })
        outTokens += Math.ceil(f.length / 2)
        await sleep(gap)
      }
      send('content_block_stop', { type: 'content_block_stop', index })
    } else if (block.type === 'tool_use') {
      send('content_block_start', {
        type: 'content_block_start', index,
        content_block: { type: 'tool_use', id: rid('toolu_'), name: resolveToolName(block.tool, toolMap, plan.label), input: {} }
      })
      const json = JSON.stringify(expandVars(block.input ?? {}))
      const frames = chunkText(json, 24)
      const gap = dur / Math.max(1, frames.length)
      for (const f of frames) {
        send('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: f } })
        outTokens += 2
        await sleep(gap)
      }
      send('content_block_stop', { type: 'content_block_stop', index })
    }
    index++
  }
  send('message_delta', { type: 'message_delta', delta: { stop_reason: plan.stop, stop_sequence: null }, usage: { output_tokens: outTokens } })
  send('message_stop', { type: 'message_stop' })
  res.end()
}

// ---------- replay: OpenAI SSE (gateway fallback) ----------
async function playOpenAI(res, plan, model, toolMap) {
  const id = rid('chatcmpl-')
  const created = Math.floor(Date.now() / 1000)
  const send = (delta, finish = null) =>
    res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`)
  send({ role: 'assistant', content: '' })
  let toolIdx = 0
  for (const block of plan.blocks) {
    const dur = Math.max(50, block.durationMs ?? 1000)
    if (block.type === 'text' || block.type === 'thinking') {
      const frames = chunkText(expandVars(block.text), script.textCharsPerFrame ?? 3)
      const gap = dur / Math.max(1, frames.length)
      for (const f of frames) {
        send(block.type === 'thinking' ? { reasoning_content: f } : { content: f })
        await sleep(gap)
      }
    } else if (block.type === 'tool_use') {
      const json = JSON.stringify(expandVars(block.input ?? {}))
      send({ tool_calls: [{ index: toolIdx, id: rid('call_'), type: 'function', function: { name: resolveToolName(block.tool, toolMap, plan.label), arguments: '' } }] })
      const frames = chunkText(json, 24)
      const gap = dur / Math.max(1, frames.length)
      for (const f of frames) {
        send({ tool_calls: [{ index: toolIdx, function: { arguments: f } }] })
        await sleep(gap)
      }
      toolIdx++
    }
  }
  send({}, plan.stop === 'tool_use' ? 'tool_calls' : 'stop')
  res.write('data: [DONE]\n\n')
  res.end()
}

// ---------- record mode: transparent proxy + frame dump ----------
async function recordProxy(req, res, bodyStr, pathname) {
  const seq = ++reqSeq
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const base = path.join(__dirname, 'recorded', `${stamp}-${String(seq).padStart(3, '0')}`)
  fs.mkdirSync(path.dirname(base), { recursive: true })
  fs.writeFileSync(base + '.request.json', bodyStr)
  const headers = { 'content-type': 'application/json', 'anthropic-version': req.headers['anthropic-version'] ?? '2023-06-01' }
  if (UPSTREAM_KEY) {
    headers['x-api-key'] = UPSTREAM_KEY
    headers['authorization'] = `Bearer ${UPSTREAM_KEY}`
  }
  const upstream = await fetch(UPSTREAM + pathname, { method: 'POST', headers, body: bodyStr })
  res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json' })
  if (!upstream.body) return res.end()
  const dump = fs.createWriteStream(base + '.frames.ndjson')
  const t0 = Date.now()
  const reader = upstream.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    const s = dec.decode(value, { stream: true })
    res.write(s)
    buf += s
    let nl
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trimEnd()
      buf = buf.slice(nl + 1)
      if (line) dump.write(JSON.stringify({ t: Date.now() - t0, line }) + '\n')
    }
  }
  dump.end()
  res.end()
  log(`recorded #${seq} -> ${path.basename(base)}.*`)
}

// ---------- http server ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x')
  try {
    if (req.method === 'GET' && url.pathname === '/v1/models') {
      const id = script?.model ?? 'GLM-5.2'
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({
        object: 'list',
        data: [{ id, object: 'model', type: 'model', display_name: id, created: 1735689600, owned_by: 'replay-demo' }]
      }))
    }
    if (req.method === 'POST' && url.pathname === '/v1/messages/count_tokens') {
      await readBody(req)
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ input_tokens: 2048 }))
    }
    if (req.method === 'POST' && (url.pathname === '/v1/messages' || url.pathname === '/v1/chat/completions')) {
      const bodyStr = await readBody(req)
      if (MODE === 'record') return recordProxy(req, res, bodyStr, url.pathname)
      const body = JSON.parse(bodyStr || '{}')
      fs.writeFileSync(path.join(STATE_DIR, 'requests', `${String(++reqSeq).padStart(3, '0')}.json`), bodyStr)
      const plan = resolvePlan(body, bodyStr)
      const toolMap = buildToolNameMap(body.tools)
      if (!loggedBinding && Object.keys(toolMap).length) {
        loggedBinding = true
        const scripted = new Set(script.turns.flatMap((t) => t.blocks).filter((b) => b.type === 'tool_use').map((b) => b.tool))
        log('tool binding for this session:')
        for (const s of scripted) log(`    ${s.padEnd(18)} -> ${toolMap[s] ?? '*** NOT REGISTERED ***'}`)
      }
      log(`${url.pathname} model=${body.model} -> ${plan.label}`)

      if (body.stream === false) {
        const text = plan.blocks.filter((b) => b.type === 'text').map((b) => b.text).join('')
        res.writeHead(200, { 'content-type': 'application/json' })
        if (url.pathname === '/v1/messages') {
          return res.end(JSON.stringify({
            id: rid('msg_'), type: 'message', role: 'assistant', model: body.model,
            content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null,
            usage: { input_tokens: 2048, output_tokens: 64 }
          }))
        }
        return res.end(JSON.stringify({
          id: rid('chatcmpl-'), object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: body.model,
          choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 2048, completion_tokens: 64, total_tokens: 2112 }
        }))
      }
      sseHead(res)
      if (url.pathname === '/v1/messages') await playAnthropic(res, plan, body.model ?? script.model, toolMap)
      else await playOpenAI(res, plan, body.model ?? script.model, toolMap)
      return
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { type: 'not_found_error', message: `no route: ${req.method} ${url.pathname}` } }))
    log(`404 ${req.method} ${url.pathname}`)
  } catch (err) {
    log('ERROR', err?.message ?? err)
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { type: 'api_error', message: String(err?.message ?? err) } }))
    } else {
      res.end()
    }
  }
})

server.listen(PORT, '127.0.0.1', () => {
  log(`mode=${MODE} listening on http://127.0.0.1:${PORT}${MODE === 'record' ? ` -> upstream ${UPSTREAM}` : ''}`)
  if (MODE === 'record' && !UPSTREAM_KEY) log('WARNING: REPLAY_UPSTREAM_KEY is not set — upstream calls will be unauthenticated')
})
