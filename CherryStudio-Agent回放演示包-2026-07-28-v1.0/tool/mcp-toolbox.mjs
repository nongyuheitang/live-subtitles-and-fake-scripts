#!/usr/bin/env node
/**
 * Replay toolbox — stdio MCP server with two modes.
 *
 *   replay (default): pretend-execute. Each tools/call is matched against the scripted tool_use
 *                     blocks in script.json **by (tool name + input)** — not by a sequential
 *                     cursor. That makes replay stateless: retries are idempotent, several
 *                     sessions can run at once, and no "reset before every demo" step exists.
 *                     A match sleeps result.durationMs, optionally materializes a file, then
 *                     returns result.output.
 *   live            : really execute (bash via /bin/zsh, save_file writes content) and append
 *                     {tool, input, durationMs, output} to recorded-tools.ndjson for scripting.
 *
 * Usage:
 *   node mcp-toolbox.mjs --script scripts/server-inspection --out-dir <dir> [--mode replay|live]
 *
 * stdout is reserved for JSON-RPC; logging goes to stderr + .state/toolbox.log.
 */
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const argv = process.argv.slice(2)
const args = {}
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a.startsWith('--')) args[a.slice(2)] = argv[i + 1]?.startsWith('--') ? true : argv[++i]
}
const MODE = args.mode ?? 'replay'
const SCRIPT_DIR = args.script ? path.resolve(__dirname, args.script) : path.join(__dirname, 'scripts/server-inspection')
const OUT_DIR = path.resolve(args['out-dir'] ?? path.join(SCRIPT_DIR, 'out'))
const STATE_DIR = path.join(SCRIPT_DIR, '.state')
fs.mkdirSync(STATE_DIR, { recursive: true })
fs.mkdirSync(OUT_DIR, { recursive: true })

const logFile = fs.createWriteStream(path.join(STATE_DIR, 'toolbox.log'), { flags: 'a' })
const log = (...xs) => {
  const line = `[toolbox ${new Date().toISOString()}] ${xs.join(' ')}`
  console.error(line)
  logFile.write(line + '\n')
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function expandVars(value) {
  if (typeof value === 'string') return value.replaceAll('{{OUTPUT_DIR}}', OUT_DIR).replaceAll('{{SCRIPT_DIR}}', SCRIPT_DIR)
  if (Array.isArray(value)) return value.map(expandVars)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, expandVars(v)]))
  return value
}

/** Canonical form of an input object: key-sorted JSON, so property order never breaks a match. */
const canon = (obj) => JSON.stringify(obj, Object.keys(obj ?? {}).sort())

// Flatten every scripted tool_use that carries a `result` — those are ours to fake.
// (`report_artifacts` has no result: it is Cherry's own builtin and really executes.)
let scriptedCalls = []
if (MODE === 'replay') {
  const script = JSON.parse(fs.readFileSync(path.join(SCRIPT_DIR, 'script.json'), 'utf8'))
  scriptedCalls = script.turns
    .flatMap((t) => t.blocks)
    .filter((b) => b.type === 'tool_use' && b.result)
    .map((b) => ({ tool: b.tool, input: expandVars(b.input ?? {}), result: b.result }))
  log(`loaded ${scriptedCalls.length} scripted tool results from ${path.basename(SCRIPT_DIR)}`)
}

const TOOLS = [
  {
    name: 'bash',
    description: 'Execute a shell command and return its output. Use `description` to state the purpose in Chinese.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The shell command to execute' },
        description: { type: 'string', description: 'Short human-readable purpose of this command, in Chinese' }
      },
      required: ['command']
    }
  },
  {
    name: 'save_file',
    description: 'Generate and save a deliverable file. Use `description` to state the purpose in Chinese.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Target file path (relative to the output directory)' },
        content: { type: 'string', description: 'File content when applicable' },
        description: { type: 'string', description: 'Short human-readable purpose, in Chinese' }
      },
      required: ['path']
    }
  },
  {
    name: 'read_file',
    description: 'Read a text file and return its content.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }
  }
]

/** Find the scripted result for this call: exact (tool+input) first, then same-tool fallback. */
function findScripted(name, input) {
  const want = canon(input)
  const exact = scriptedCalls.find((c) => c.tool === name && canon(c.input) === want)
  if (exact) return { entry: exact, how: 'exact' }
  const byName = scriptedCalls.filter((c) => c.tool === name)
  if (byName.length === 1) return { entry: byName[0], how: 'tool-name (input differed)' }
  return { entry: undefined, how: 'none' }
}

async function callReplay(name, input) {
  const { entry, how } = findScripted(name, input)
  if (!entry) {
    log(`WARN no scripted result for ${name} ${JSON.stringify(input).slice(0, 160)}`)
    return `（演示剧本中没有这一步：${name}）`
  }
  const dur = entry.result.durationMs ?? 1000
  log(`replay ${name} [${how}] sleep=${dur}ms`)
  await sleep(dur)
  if (entry.result.writeFile) {
    const src = path.resolve(SCRIPT_DIR, entry.result.writeFile.from)
    const dst = path.resolve(OUT_DIR, entry.result.writeFile.to)
    fs.mkdirSync(path.dirname(dst), { recursive: true })
    fs.copyFileSync(src, dst)
    log(`materialized ${dst}`)
  }
  return entry.result.output ?? ''
}

function callLive(name, input) {
  const t0 = Date.now()
  let output = ''
  try {
    if (name === 'bash') {
      output = execSync(input.command, {
        shell: '/bin/zsh', encoding: 'utf8', timeout: 180_000, maxBuffer: 16 * 1024 * 1024,
        cwd: OUT_DIR, stdio: ['ignore', 'pipe', 'pipe']
      })
    } else if (name === 'save_file') {
      const dst = path.resolve(OUT_DIR, input.path)
      fs.mkdirSync(path.dirname(dst), { recursive: true })
      fs.writeFileSync(dst, input.content ?? '')
      output = `saved: ${dst} (${(input.content ?? '').length} bytes)`
    } else if (name === 'read_file') {
      output = fs.readFileSync(path.resolve(OUT_DIR, input.path), 'utf8').slice(0, 32_768)
    } else {
      output = `unknown tool: ${name}`
    }
  } catch (err) {
    output = `ERROR: ${err?.stderr?.toString?.() ?? ''}${err?.stdout?.toString?.() ?? ''}\n${String(err?.message ?? err)}`
  }
  const durationMs = Date.now() - t0
  fs.appendFileSync(path.join(SCRIPT_DIR, 'recorded-tools.ndjson'), JSON.stringify({ tool: name, input, durationMs, output }) + '\n')
  log(`live ${name} took ${durationMs}ms`)
  return output
}

// ---------- JSON-RPC over stdio (newline-delimited) ----------
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n')

// Serialize tool calls so their (sleep-heavy) execution keeps arrival order in the UI.
let toolChain = Promise.resolve()
let pendingCalls = 0
function enqueueToolCall(id, name, input) {
  pendingCalls++
  toolChain = toolChain.then(async () => {
    try {
      const text = MODE === 'replay' ? await callReplay(name, input) : callLive(name, input)
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }], isError: false } })
    } catch (err) {
      log('ERROR tools/call', err?.stack ?? err)
      send({ jsonrpc: '2.0', id, error: { code: -32603, message: String(err?.message ?? err) } })
    } finally {
      pendingCalls--
    }
  })
}

const rl = readline.createInterface({ input: process.stdin, terminal: false })
let pending = 0
rl.on('line', async (line) => {
  line = line.trim()
  if (!line) return
  let msg
  try { msg = JSON.parse(line) } catch { return log('bad json line', line.slice(0, 120)) }
  const { id, method, params } = msg
  pending++
  try {
    if (method === 'initialize') {
      send({
        jsonrpc: '2.0', id,
        result: {
          protocolVersion: params?.protocolVersion ?? '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'toolbox', version: '2.0.0' }
        }
      })
    } else if (method?.startsWith('notifications/')) {
      // notifications need no response
    } else if (method === 'ping') {
      send({ jsonrpc: '2.0', id, result: {} })
    } else if (method === 'tools/list') {
      send({ jsonrpc: '2.0', id, result: { tools: TOOLS } })
    } else if (method === 'tools/call') {
      enqueueToolCall(id, params?.name, params?.arguments ?? {})
    } else if (id !== undefined) {
      send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } })
    }
  } catch (err) {
    log('ERROR', err?.stack ?? err)
    if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: -32603, message: String(err?.message ?? err) } })
  } finally {
    pending--
  }
})
// Don't exit while a (slow, sleeping) tools/call is still in flight.
rl.on('close', () => {
  const t = setInterval(() => {
    if (pending === 0 && pendingCalls === 0) {
      clearInterval(t)
      process.exit(0)
    }
  }, 50)
})

log(`started mode=${MODE} script=${path.basename(SCRIPT_DIR)} out=${OUT_DIR}`)
