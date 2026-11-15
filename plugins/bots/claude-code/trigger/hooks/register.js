// OptChat for a DinoBot bot on Claude Code: after each answered main-loop turn, compact. $.session.compact() runs every
// hook but the calling mod's own, so this lives apart from the view mod (../view), whose session.compact hook answers
// it with the memory view.
export function register(on) {
  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId || e.isAborted || e.reason !== 'answer') return r
    $.clock.after(300, async () => {
      try {
        const res = await $.session.compact()
        if (res && res.skip) $.ui.log('optchat: compaction skipped (' + res.skip + ')')
      } catch (err) {
        $.ui.log('optchat: compact failed: ' + err)
      }
    })
    return r
  })
}
