// OptChat for a DinoBot bot on Claude Code: the inbox's ack and the compactor.
//
// Inbox: the bots plugin's engine (plugins/bots/server/cc/engine.ts) journals what the bot is sent (the app, bot-dm,
// rooms) and types each item into this TUI with `herdr agent prompt` while the session is idle (server/cc/deliver.ts).
// This mod submits nothing: a mod's $.prompt.submit is held after a Stop until the person types, typed text is not.
// Its prompt.submit hook is the ack: it reports every typed prompt (POST /turn typed), and the engine matches it to
// the item it typed. A new session says /hello: the engine types again what the old one had typed and not seen, and
// logs a message whose turn died with it as unanswered (as pi-optchat recovers it).
//
// Compactor: the engine's memory needs one-line summaries. It queues them as jobs; this mod runs each with
// $.model.complete, through this session's own client and login (the user's Claude plan), and posts the line back.
// When the bot's summaries run on pi (compactorRunner, server/cc/compactor-runner.ts) the engine asks the host's pi
// instead and hands this mod a job only when pi fails.
//
// Usage: the app's context meter and the chat's cost (the bots plugin's server/cc/usage.ts). After each turn
// (session.measure), at start and after each compaction this mod posts Claude Code's own figures to /usage: the
// context window and its fill, the session's cost (/cost's), the rate-limit windows and this process's turn tokens.
// The compactor's $.model.complete calls are not in Claude Code's cost: their usage goes with each /job, priced there.

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
    // A restarted daemon listens on a new port with a new token: read engine.json again.
    if ((res.status === 401 || res.status === 404) && !k) continue
    return { status: res.status, json: JSON.parse(res.text || '{}') }
  }
}

let shown = ''
const status = ($, text) => {
  if (shown !== text) $.ui.status((shown = text))
}

const MAX_JOBS = 4
let running = 0
async function compactor($) {
  if (running >= MAX_JOBS) return
  let jobs = []
  try {
    jobs = (await engine($, 'GET', '/jobs?max=' + (MAX_JOBS - running))).json.jobs || []
  } catch {
    return
  }
  for (const job of jobs) {
    running++
    run($, job).finally(() => running--)
  }
}

async function run($, job) {
  let out
  try {
    const r = await $.model.complete({
      model: job.model,
      system: [{ text: job.system, cache: true }],
      prompt: job.prompt.map((b) => (b.cache ? { text: b.text, cache: true } : { text: b.text })),
      maxTokens: job.maxTokens,
      ...(job.effort ? { effort: job.effort } : {}),
      timeoutMs: 5 * 60_000,
    })
    out = r.isAnswered
      ? { id: job.id, text: r.text, usage: r.usage, model: job.model }
      : { id: job.id, error: r.reason + (r.error ? ' ' + r.error : ''), ...(typeof r.status === 'number' ? { status: r.status } : {}) }
  } catch (err) {
    out = { id: job.id, error: String((err && err.message) || err), status: 400 }
  }
  try {
    await engine($, 'POST', '/job', out)
  } catch {}
}

// This TUI process: Claude Code's figures start at 0 in each, so the engine counts per run.
let runKey = ''
const tokens = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
function addTokens(u) {
  if (!u) return
  for (const k of Object.keys(tokens)) if (typeof u[k] === 'number' && u[k] > 0) tokens[k] += u[k]
}
// `u`: $.session.usage()'s or session.measure's figures; a local estimate of the fill when no response gave one.
async function report($, u) {
  if (!runKey || !u) return
  const c = u.context || {}
  const estimate = c.breakdown && typeof c.breakdown.totalTokens === 'number' ? c.breakdown.totalTokens : undefined
  try {
    await engine($, 'POST', '/usage', {
      run: runKey,
      context: { window: c.window, tokens: c.tokens, ...(estimate !== undefined ? { estimate } : {}) },
      ...(u.cost && typeof u.cost.usd === 'number' ? { costUsd: u.cost.usd } : {}),
      tokens,
      rateLimits: u.rateLimits || [],
    })
  } catch {}
}
// The fill after a relaunch or a compaction: no response has measured it yet, so a local count (free, no request).
async function reportEstimate($) {
  try {
    const u = await $.session.usage({ breakdown: 'summary' })
    if (typeof u.context.tokens === 'number') delete u.context.breakdown
    await report($, u)
  } catch {
    try {
      await report($, await $.session.usage())
    } catch {}
  }
}

export function register(on) {
  on('session.start', async ($, e, next) => {
    try {
      const h = await engine($, 'POST', '/hello', {})
      status($, 'optchat: ' + h.json.inbox + ' waiting')
    } catch (err) {
      status($, 'optchat: engine unavailable')
    }
    try {
      runKey = (await $.session.id()) + ':' + (await $.clock.now())
    } catch {}
    void reportEstimate($)
    $.clock.every(1000, () => compactor($))
    return next(e)
  })

  // Every prompt starts a turn: the engine holds the inbox until it is done. A typed one is the ack of the item the
  // engine typed, or else (typed by a person in the terminal) a turn the app shows as such. So is one Claude Code
  // submits itself, e.g. a background task's <task-notification> (origin kind `task-notification`): its origin goes
  // along, so the app shows it as the task's row, not as the person's words. A prompt Claude Code puts into the
  // running turn (e.turnId: a notice of a background task that ended mid-turn, text typed over the turn) starts no
  // turn: `into` says so, and that turn's one turn.complete ends it.
  on('prompt.submit', async ($, e, next) => {
    if (!e.command) {
      const origin = e.origin && typeof e.origin.kind === 'string' ? e.origin.kind : undefined
      try {
        await engine($, 'POST', '/turn', { running: true, typed: true, into: !!e.turnId, text: e.text, ...(origin ? { origin } : {}) })
      } catch {}
    }
    return next(e)
  })

  // The chat's model and effort (the app's picker) for each main-loop step: a switch applies from the next step, as
  // for a bot on pi, with no restart. The engine unset or unreachable: the step runs as Claude Code set it.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId) return yield* next(e)
    // Not `run`: Claude Code refuses a hooks module that assigns to the name of a function it hands $ (run, above).
    let want = {}
    try {
      want = (await engine($, 'GET', '/run')).json || {}
    } catch {}
    const change = {}
    if (typeof want.model === 'string' && want.model && want.model !== e.model) change.model = want.model
    if (typeof want.effort === 'string' && want.effort && want.effort !== e.effort) change.effort = want.effort
    return yield* next({ ...e, ...change })
  })

  // Claude Code's figures after each main-thread turn (and when a rate-limit window moves).
  on('session.measure', async ($, e, next) => {
    const r = await next(e)
    void report($, e)
    return r
  })

  // The view mod's compaction after each turn (and Claude Code's own): the window now holds the view.
  on('session.compact', async ($, e, next) => {
    const r = await next(e)
    // Counted once the compaction is in place.
    $.clock.after(1000, () => reportEstimate($))
    return r
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    // Every loop's turns cost tokens (a subagent's too, as in Claude Code's cost).
    addTokens(e.usage)
    if (!e.agentId) {
      try {
        // A refusal or an API error ends the turn unanswered: what the API said goes along (the chat shows it).
        const why =
          e.reason === 'refusal' && e.refusal
            ? { refusal: e.refusal }
            : e.reason === 'error' && typeof e.answer === 'string' && e.answer.trim()
              ? { error: e.answer.trim().slice(0, 1000) }
              : {}
        await engine($, 'POST', '/turn', { running: false, answered: !e.isAborted && e.reason === 'answer', reason: e.reason || null, ...why })
      } catch {}
    }
    return r
  })
}
