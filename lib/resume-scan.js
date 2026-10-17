/**
 * Pure restart-scan fold over a persisted session log.
 *
 * Kept separate from the plugin so it can be exercised against real session
 * logs without a host: it only reads events, never context services.
 *
 * @module dsh-autocontinue/resume-scan
 */

/** Flatten the text blocks of one message. */
function messageText(message) {
  const blocks = message?.content
  if (!Array.isArray(blocks)) return ''
  return blocks
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim()
}

/**
 * Fold one persisted event log into everything a restart needs to know:
 * whether the tail is an interrupted run, where it stopped, the pending input
 * the shutdown canceled, the unfinished jobs the process owned, and the last
 * session generation boundary.
 *
 * A generation starts at each durable `session/end-seed`. Only input and jobs
 * recorded after the last marker belong to the process that just died; older
 * canceled batches belonged to a generation that already handled them.
 *
 * @param events - the raw persisted event log (before any resume closers).
 */
export function resumeState(events, handledSeq = 0) {
  let open = false
  let lastTurnEnd
  let turn
  let step
  let lastSeed = -1
  let lastSeedTime = 0
  const inbox = { 'next-turn': [], 'next-step': [] }
  const canceled = []
  const jobs = new Map()
  let goal
  const admittedIds = new Set()
  const admittedTexts = new Set()
  for (const event of events) {
    if (event.type === 'turn/start') {
      open = true
      lastTurnEnd = undefined
      turn = event.data?.turn
      step = undefined
    } else if (event.type === 'turn/end') {
      open = false
      lastTurnEnd = event
      turn = event.data?.turn ?? turn
    } else if (event.type === 'step/start' || event.type === 'step/end') {
      step = event.data?.step
    } else if (event.type === 'session/end-seed') {
      lastSeed = event.seq
      lastSeedTime = event.time ?? 0
    } else if (event.type === 'agent/inbox/spliced') {
      const data = event.data ?? {}
      const target = data.target === 'next-step' ? 'next-step' : 'next-turn'
      const start = Number.isSafeInteger(data.start) ? data.start : 0
      const removedCount = Number.isSafeInteger(data.removedCount) ? data.removedCount : 0
      const entries = inbox[target]
      const removed = entries.slice(start, start + removedCount)
      entries.splice(start, removedCount, ...(data.inserted ?? []).map((message) => ({ message, seq: event.seq })))
      if (data.outcome === 'canceled' && removed.length > 0) {
        canceled.push({ seq: event.seq, messages: removed.map((entry) => entry.message) })
      }
    } else if (event.type === 'user/message') {
      if (event.data?.id !== undefined) admittedIds.add(event.data.id)
      const text = messageText(event.data)
      if (text !== '') admittedTexts.add(text)
    } else if (event.type === 'goal/change') {
      const next = event.data?.goal
      if (next !== undefined && next !== null) goal = { ...next, roundsStarted: event.data?.roundsStarted }
    } else if (event.type === 'job/registered') {
      jobs.set(event.data?.jobId, event.data)
    } else if (event.type === 'job/settled') {
      jobs.delete(event.data?.jobId)
    }
  }
  const pending = [...inbox['next-turn'], ...inbox['next-step']]
    .filter((entry) => entry.seq > lastSeed)
    .map((entry) => entry.message)
  const pendingIds = new Set(pending.map((message) => message.id))
  const pendingTexts = new Set(pending.map(messageText).filter((text) => text !== ''))
  // The shutdown cancels queued input at dispose. A reattaching tab can append
  // a fresh `session/end-seed` before the scan runs, so the marker is not a
  // reliable cutoff: track the last handled cancellation per session instead.
  // A steer move looks like a cancel plus a re-insert of the same identity, so
  // restore only messages that are neither still pending nor already admitted.
  const latestCancel = canceled.filter((batch) => batch.seq > handledSeq).at(-1)
  const recoverable = []
  const restoredIds = new Set()
  const restoredTexts = new Set()
  if (latestCancel !== undefined) {
    for (const message of latestCancel.messages) {
      const text = messageText(message)
      if (message.id !== undefined && (pendingIds.has(message.id) || admittedIds.has(message.id))) continue
      if (text !== '' && (pendingTexts.has(text) || admittedTexts.has(text))) continue
      if (message.id !== undefined && restoredIds.has(message.id)) continue
      if (text !== '' && restoredTexts.has(text)) continue
      if (message.id !== undefined) restoredIds.add(message.id)
      if (text !== '') restoredTexts.add(text)
      recoverable.push(message)
    }
  }
  return {
    interrupted: open || lastTurnEnd?.data?.reason?.kind === 'interrupted',
    turn,
    step,
    lastType: events[events.length - 1]?.type,
    pending,
    recoverable,
    restoreSeq: latestCancel?.seq,
    jobs: [...jobs.values()].filter((job) => (job.startedAt ?? 0) > lastSeedTime),
    goal: goal !== undefined && goal.phase === 'active' && (goal.maxGoalRounds === 0 || (goal.roundsStarted ?? 0) < goal.maxGoalRounds)
      ? { id: goal.id, objective: goal.objective, revision: goal.revision, roundsStarted: goal.roundsStarted, maxGoalRounds: goal.maxGoalRounds }
      : undefined,
    lastSeed,
    lastSeedTime
  }
}
