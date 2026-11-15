// OptChat for a DinoBot bot on Claude Code (UniiChat shape): every turn is
//   [tools][OptChat system prompt][<chat>view</chat>][new message]; nothing else is carried over.
// After each answered turn the trigger mod (../trigger) calls $.session.compact(). This mod's session.compact hook
// logs the turn's messages into the bot's OptChat memory (the bots plugin's engine, pi-optchat's Memory), waits until
// they are summarised (the inbox mod runs the compactions on this session), and answers the compaction with the view.
// It also gives the session OptChat's system prompt, the memory tools (zoom, date, search_memory), short tool texts,
// and reports each step (its thinking too) and tool call to the engine, which shows them in the DinoBot app.

let conn = null
async function engine($, method, path, body) {
  for (let k = 0; k < 2; k++) {
    if (!conn || k) conn = JSON.parse(await $.fs.read(await $.env.get('OPTCHAT_ENGINE_FILE')))
    let res
    try {
      res = await $.http.fetch(conn.url + path, {
        method,
        headers: { authorization: 'Bearer ' + conn.token, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
    } catch (err) {
      if (k) throw err
      continue
    }
    if ((res.status === 401 || res.status === 404) && !k) continue
    return { status: res.status, json: JSON.parse(res.text || '{}') }
  }
}
const post = ($, path, body) => engine($, 'POST', path, body).catch(() => null)

// Optional debug log (OPTCHAT_MOD_LOG): the last 500 events as JSON lines.
let logPath
const logLines = []
async function log($, obj) {
  if (logPath === undefined) logPath = (await $.env.get('OPTCHAT_MOD_LOG')) || ''
  if (!logPath) return
  logLines.push(JSON.stringify({ t: new Date().toISOString(), ...obj }))
  if (logLines.length > 500) logLines.splice(0, logLines.length - 500)
  try {
    await $.fs.write(logPath, logLines.join('\n') + '\n')
  } catch {}
}

// OPTCHAT_STRIP (default on): drop what Claude Code adds around the view every turn (CLAUDE.md, memory and date
// context blocks, reminders and other injected attachments, the env message), so a turn's prefix only grows.
let strip = null
const stripOn = async ($) => (strip ??= (await $.env.get('OPTCHAT_STRIP')) !== '0')

async function systemPrompt($) {
  const r = await engine($, 'GET', '/prompt')
  const base = r && r.status === 200 ? r.json.text : ''
  if (!base) return ''
  const cwd = (await $.env.get('PWD')) || ''
  const home = (await $.env.get('HOME')) || ''
  const platform = home.startsWith('/Users/') ? 'macOS' : 'Linux'
  return `${base}\n\n# Environment\nWorking directory: ${cwd}\nPlatform: ${platform}, shell bash.\nToday's date: ${new Date().toISOString().slice(0, 10)}.`
}

const stripReminders = (s) => s.replace(/<system-reminder>[\s\S]*?<\/system-reminder>\s*/g, '').trim()
const afterView = (t) => (t.startsWith('<chat>') ? t.slice(t.indexOf('</chat>') + 7).trim() : t)

// Claude Code's notice that a background task ended (<task-notification>…</task-notification>, submitted as a turn of
// its own) is not the person's words: memory logs it as a tool result (echo), never as `user`.
// Same parser as the bots plugin's server/cc/task-notification.ts.
const ntag = (t, name) => {
  const m = new RegExp(`<${name}>\\s*([\\s\\S]*?)\\s*</${name}>`, 'i').exec(t)
  return (m && m[1].trim()) || ''
}
function notificationEcho(text) {
  if (!/^\s*<task-notification>/.test(text)) return null
  const id = ntag(text, 'task-id') || ntag(text, 'task_id')
  const call = ntag(text, 'tool-use-id') || ntag(text, 'tool_use_id')
  const status = ntag(text, 'status')
  const summary = ntag(text, 'summary')
  const file = ntag(text, 'output-file') || ntag(text, 'output_file')
  const head = `Background task${id ? ' ' + id : ''}${call ? ` (call ${call})` : ''}${status ? ' ' + status : ''}`
  return head + (summary ? `: ${summary}` : '') + (file ? `. Output file: ${file}` : '')
}

// SessionMessage[] -> OptChat log entries (kinds as pi-optchat: user, talk, tool, echo). Skipped: the messages the
// last compaction handed back (view + previous exchange) and any an `auto` compaction mid-turn logged already.
let carried = 0
const loggedHandles = new Set()
function toEntries(all) {
  const out = []
  const messages = all.slice(carried && /^<chat>/.test(all[0]?.text || '') ? carried : 0).filter((m) => !(m.handle && loggedHandles.has(m.handle)))
  const toolOf = new Map()
  for (const m of all) for (const u of m.toolUses ?? []) toolOf.set(u.tool_use_id, u.tool)
  for (const m of messages) {
    if (m.handle) loggedHandles.add(m.handle)
    if (m.role === 'user') {
      for (const r of m.toolResults ?? []) {
        const name = toolOf.get(r.tool_use_id)
        out.push({ kind: 'echo', text: (name ? `${name}: ` : '') + (r.isError ? '[error] ' : '') + (r.text ?? JSON.stringify(r.result ?? '')) })
      }
      const text = afterView(stripReminders(m.text || ''))
      const echo = text && notificationEcho(text)
      if (echo) out.push({ kind: 'echo', text: echo })
      else if (text) out.push({ kind: 'user', text })
    } else {
      if (m.text?.trim()) out.push({ kind: 'talk', text: m.text.trim() })
      for (const u of m.toolUses ?? []) out.push({ kind: 'tool', text: `${u.tool} ${JSON.stringify(u.input)}` })
    }
  }
  return out
}

// pi-optchat's previous exchange: the turn's requests and its final answer, in full, when the answer is plain text
// after the last tool call and the whole exchange is within the limit.
function previousExchange(all, limit) {
  const messages = all.slice(carried && /^<chat>/.test(all[0]?.text || '') ? carried : 0)
  const last = messages.findLastIndex((m) => m.role === 'assistant')
  const answer = messages[last]
  if (!answer || answer.toolUses?.length || !answer.text?.trim()) return null
  const requests = messages
    .slice(0, last)
    .filter((m) => m.role === 'user' && !(m.toolResults || []).length)
    .map((m) => afterView(stripReminders(m.text || '')))
    .filter((t) => t && !notificationEcho(t))
  if (!requests.length) return null
  const size = new TextEncoder().encode(requests.join('') + answer.text).length
  return size <= limit ? { requests, answer: answer.text.trim() } : null
}

// Short descriptions for Claude Code's tools (its own run to about 11.7K characters); schemas unchanged.
const TOOL_TEXT = {
  Read: 'Read a file by absolute path. Returns lines numbered from 1 (cat -n style); use offset/limit for long files. Reads images, PDFs (pages for big ones) and notebooks too. Read a file before editing it.',
  Write: 'Write a file by absolute path, replacing it whole. For an existing file, Read it first; prefer Edit for changes.',
  Edit: 'Replace old_string with new_string in a file (absolute path) you have Read. old_string must match exactly, indentation included, and be unique unless replace_all is set.',
  Bash: 'Run a bash command and return its output. The working directory persists between calls; the shell state does not. Quote paths with spaces. Optional timeout in ms (max 600000); run_in_background for long jobs. Prefer Read/Edit/Write/Grep/Glob over cat, sed, grep and find.',
  Grep: 'Search file contents with ripgrep regex. output_mode: files_with_matches (default), content (with -n, -A/-B/-C context) or count. Filter with glob or type; multiline for patterns across lines.',
  Glob: 'Find files by glob pattern (e.g. "src/**/*.ts"), newest first. Optional path to search under.',
}

// pi-optchat's memory tools (src/tools.ts): same names, words and bounds, as built-in tools of the session.
const MEMORY_TOOLS = [
  {
    name: 'zoom',
    description: 'Open the line id+n of the view into the two lines of n/2 under it; n = 1 gives the message whole.',
    inputSchema: { type: 'object', properties: { id: { type: 'integer', minimum: 0 }, n: { type: 'integer', minimum: 1 } }, required: ['id', 'n'] },
  },
  {
    name: 'search_memory',
    description:
      'Last resort, only once zooming has failed: find original messages containing every term (case-insensitive), newest first. Each hit is id+0|kind date: snippet; zoom id 1 for the whole message. The view is your memory and its latest word on a thing is the truth: first find the latest mention there and zoom.',
    inputSchema: { type: 'object', properties: { query: { type: 'string', minLength: 1 }, limit: { type: 'integer', minimum: 1, maximum: 100 } }, required: ['query'] },
  },
  {
    name: 'date',
    description: 'The date and time of message id.',
    inputSchema: { type: 'object', properties: { id: { type: 'integer', minimum: 0 } }, required: ['id'] },
  },
]
const MEMORY_TOOL_NAMES = new Set(MEMORY_TOOLS.map((t) => t.name))
const short = (v) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v ?? '')
  return s.length > 4000 ? s.slice(0, 4000) + '…' : s
}

const THINK_MS = 250
let viewShown = false
export function register(on) {
  on('tool.list', async ($, e, next) => {
    const listed = await next(e)
    if (listed.value === undefined) return listed
    const have = new Set(listed.value.map((t) => t.name))
    return { value: [...listed.value, ...MEMORY_TOOLS.filter((t) => !have.has(t.name)).map((t) => ({ ...t, mcp: false }))] }
  })

  on('tool.call', async ($, e, next) => {
    const { tool, tool_use_id, consent, ...args } = e
    const id = tool_use_id || `${tool}-${Date.now()}`
    if (!e.agentId) await post($, '/event', { type: 'tool', phase: 'running', id, name: tool, input: args })
    let r
    if (MEMORY_TOOL_NAMES.has(tool)) {
      try {
        const a = await engine($, 'POST', '/tool', { name: tool, arguments: args })
        r = a.json.isError ? { deny: a.json.text } : { result: a.json.text }
      } catch (err) {
        r = { deny: `OptChat memory unavailable: ${err}` }
      }
    } else {
      r = await next(e)
    }
    if (!e.agentId) {
      const failed = r.deny !== undefined || r.isError === true
      await post($, '/event', { type: 'tool', phase: 'done', id, name: tool, input: args, output: short(r.deny ?? r.text ?? r.result), isError: failed })
    }
    return r
  })

  on('tool.describe', async ($, e, next) => {
    const r = await next(e)
    const text = (await $.env.get('OPTCHAT_SHORT_TOOLS')) !== '0' && TOOL_TEXT[e.tool]
    return text ? { ...r, description: text } : r
  })

  // The system prompt is OptChat's only: every core section goes, one of ours stays.
  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    try {
      const text = await systemPrompt($)
      if (text) return { sections: [{ id: 'optchat:prompt', text, scope: 'session' }] }
    } catch (err) {
      await log($, { ev: 'prompt.error', err: String(err) })
    }
    return r
  })

  on('prompt.context', async ($, e, next) => ((await stripOn($)) ? { blocks: [] } : next(e)))

  on('prompt.attachment', async ($, e, next) => {
    if (!(await stripOn($))) return next(e)
    const r = await next(e)
    // Kept: what the person sent or pointed at (a prompt queued into a running turn, a mentioned or edited file).
    return /queued|command|mention|file|edited|selection/i.test(e.type || '') ? r : { text: null }
  })

  // A new session's first prompt has no compaction before it: the view goes in front of it.
  on('prompt.submit', async ($, e, next) => {
    if (e.command) return next(e)
    const inbox = e.origin && e.origin.kind === 'plugin' && e.origin.name === 'optchat-inbox'
    if (viewShown || (e.origin && e.origin.kind !== 'composer' && !inbox)) return next(e)
    viewShown = true
    try {
      const v = await engine($, 'GET', '/view?settle=20000')
      if (v.status === 200 && v.json.total > 0) {
        await log($, { ev: 'first-prompt-view', bytes: v.json.bytes })
        return next({ ...e, text: v.json.view + '\n\n' + e.text })
      }
    } catch (err) {
      await log($, { ev: 'first-prompt-view.error', err: String(err) })
    }
    return next(e)
  })

  // The step's thinking goes to the engine as it streams (the whole block so far, at most every THINK_MS, and once
  // more when the block ends), then its answer. Empty thinking (Claude Code asked for none shown) sends nothing.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId) return yield* next(e)
    const thinking = new Map() // block index -> { text, sent, at }
    let chain = Promise.resolve()
    const flush = (index) => {
      const b = thinking.get(index)
      if (!b || b.sent === b.text.length || !b.text.trim()) return
      b.sent = b.text.length
      b.at = Date.now()
      const body = { type: 'thinking', block: `${e.turnId}:${e.index}:${index}`, text: b.text }
      chain = chain.then(() => post($, '/event', body))
    }
    const it = next(e)
    let result
    let done = false
    try {
      for (;;) {
        const step = await it.next()
        if (step.done) {
          done = true
          result = step.value
          break
        }
        const c = step.value
        if (c && c.kind === 'thinking' && typeof c.text === 'string') {
          const b = thinking.get(c.index) ?? { text: '', sent: 0, at: Date.now() }
          b.text += c.text
          thinking.set(c.index, b)
          if (Date.now() - b.at >= THINK_MS) flush(c.index)
        } else if (c && c.kind !== 'engine') for (const i of thinking.keys()) flush(i)
        yield c
      }
    } finally {
      // Left mid-stream (the chain above stopped reading): the step beneath is closed as yield* would.
      if (!done) await it.return?.()
    }
    for (const i of thinking.keys()) flush(i)
    await chain
    if (result.answer && result.answer.trim()) await post($, '/event', { type: 'step', answer: result.answer })
    return result
  })

  on('session.compact', async ($, e, next) => {
    await log($, { ev: 'session.compact', trigger: e.trigger, agentId: e.agentId ?? null, inMessages: e.messages.length })
    if (e.agentId) return next(e)
    if (e.trigger === 'precompute') return { skip: 'OptChat owns compaction' }
    viewShown = true
    try {
      // `auto` fires mid-turn (context full): log what the turn did so far, then hand back the fresh view and the
      // turn's own prompt, so the turn goes on from its summaries. The turn-end compaction skips what is logged here.
      const midTurn = e.trigger === 'auto'
      let prompt = midTurn ? [...e.messages].reverse().find((m) => m.role === 'user' && !(m.toolResults || []).length && (m.handle || m.text)) : null
      // A new session's first prompt carries the old view in front of it: hand back only the prompt.
      if (prompt && (prompt.text || '').startsWith('<chat>')) {
        const rest = afterView(prompt.text)
        prompt = rest ? { role: 'user', text: rest, toolUses: [] } : null
      }
      const entries = toEntries(e.messages)
      const a = await engine($, 'POST', '/append', { messages: entries })
      await log($, { ev: 'logged', ids: a.json.ids, kinds: entries.map((x) => x.kind) })
      let v
      for (let k = 0; k < 30; k++) {
        v = await engine($, 'GET', '/view?settle=20000')
        if (v.status === 200) break
        $.ui.log('optchat: waiting for summaries (' + v.json.pending + ' pending)')
      }
      if (v.status !== 200) return { skip: 'OptChat summaries are not ready' }
      const limit = v.json.previousExchange ? v.json.previousExchangeBytes : 0
      const ex = limit && !midTurn ? previousExchange(e.messages, limit) : null
      await log($, { ev: 'view', bytes: v.json.bytes, total: v.json.total, midTurn, previousExchange: !!ex })
      // The previous exchange goes after </chat>, so the view comes first.
      const messages =
        midTurn && prompt
          ? [{ role: 'user', text: v.json.view, toolUses: [] }, { role: 'assistant', text: '(Context was full mid-turn: my steps so far are in the view above; continuing.)', toolUses: [] }, prompt]
          : ex
            ? [{ role: 'user', text: v.json.view + '\n\n' + ex.requests.join('\n\n'), toolUses: [] }, { role: 'assistant', text: ex.answer, toolUses: [] }]
            : [{ role: 'user', text: v.json.view, toolUses: [] }]
      carried = messages.length
      return { messages }
    } catch (err) {
      await log($, { ev: 'compact.error', err: String(err) })
      return { skip: 'OptChat memory unavailable: ' + err }
    }
  })
}
