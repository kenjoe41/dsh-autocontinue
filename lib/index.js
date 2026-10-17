/**
 * dsh-autocontinue — automatic same-session continuation with failure retry.
 *
 * Keeps an armed session moving without a human `continue`: when the agent goes
 * idle it queues the next round, and when a turn dies on a provider/network
 * failure it waits with exponential backoff and tries again instead of stopping.
 *
 * Complements `dsh-goal-round-driver`: in a session whose goal is active AND
 * armed, the driver owns the rounds and this plugin defers. It takes over when
 * no goal is driving — the common case for hands-off work and for sessions
 * "called in" by a launcher (set `enabled: true` in that profile's patch).
 *
 * @module dsh-autocontinue
 */
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import z from '@deepseek-ai/schemastery'
import { resumeState } from './resume-scan.js'

export const name = 'autocontinue'

/**
 * The version of the module generation actually loaded in this process.
 *
 * Read from the package manifest rather than hard-coded, because a running dsh
 * process keeps the JavaScript module generation it booted with: a plugin
 * installed, re-linked or edited afterwards stays invisible to it until the
 * process restarts. Reporting this in `/autocontinue status` and the debug trace
 * is what makes "is my change even loaded?" answerable — a question that cost a
 * confusing round when a re-armed session showed neither notices nor goal
 * revival because it was still running an older generation.
 */
export const version = (() => {
  try {
    const manifest = createRequire(import.meta.url)('../package.json')
    return typeof manifest?.version === 'string' ? manifest.version : 'unknown'
  } catch {
    return 'unknown'
  }
})()

/** `goals` stays optional: a profile without dsh-goal still gets plain continuation. */
export const inject = ['agents', 'commands']

export const Config = z.object({
  enabled: z.boolean().default(false).description(
    'Arm autocontinue for every session in this profile. Turn on for launcher/cron/headless profiles.'
  ),
  goalSessions: z.boolean().default(true).description(
    'Arm automatically in a session that has an active goal.'
  ),
  reviveGoals: z.boolean().default(true).description(
    'In a goal session, take the activation edge back when the goal has stopped being driven (the round driver disarms a goal after a provider failure, and a resume/fork leaves it disarmed) or was paused, so the objective keeps moving instead of stalling. Set false to leave manual pauses alone. The model\'s own `blocked` verdict is never overridden.'
  ),
  maxGoalRevives: z.number().step(1).min(0).default(5).description(
    'Consecutive goal revivals allowed before autocontinue gives up and reports it, so a goal that something keeps pausing cannot ping-pong forever. The counter resets as soon as the goal actually starts a round. 0 = unlimited.'
  ),
  maxRounds: z.number().step(1).min(0).default(0).description(
    'Continuation rounds per session; 0 = unlimited (stops on the done marker, an abort, or /autocontinue off).'
  ),
  maxRetries: z.number().step(1).min(0).default(0).description(
    'Consecutive failure retries before giving up; 0 = keep retrying.'
  ),
  idleDelayMs: z.number().step(1).min(0).default(0).description(
    'Grace period after the agent goes idle before the next round is queued. Keep 0 for one-shot/headless launchers: they dispose the plugin tree the moment the agent is idle with an empty inbox, so a pending timer never fires.'
  ),
  retryBaseDelayMs: z.number().step(1).min(0).default(15000).description(
    'First backoff after a failed turn; doubles per consecutive failure.'
  ),
  retryMaxDelayMs: z.number().step(1).min(0).default(300000).description(
    'Backoff ceiling between failure retries.'
  ),
  doneMarker: z.string().default('AUTOCONTINUE: DONE').description(
    'Exact line the model ends with to stop the loop.'
  ),
  notices: z.boolean().default(true).description(
    'Post a visible notice row in the chat when the loop arms or schedules a failure retry, so a session shows what it is doing without asking.'
  ),
  debug: z.boolean().default(false).description(
    'Append lifecycle decisions to debugFile; use when the loop is not firing as expected.'
  ),
  debugFile: z.string().default('/tmp/dsh-autocontinue.log').description(
    'Where debug mode appends its lines.'
  ),
  resumeGoalSessions: z.boolean().default(true).description(
    'On startup, also reopen sessions with an active goal even when their last turn completed, so the goal round driver continues the objective across a restart.'
  ),
  resumeUnfinished: z.boolean().default(true).description(
    'On startup, resume sessions whose persisted log ends inside an open turn (the server was stopped or crashed mid-run) and queue a continuation round for each. This is what brings workspaces back after dsh-update swaps the server: the interrupted turn is closed by the harness, the agent is reopened, and a resume round carries the work forward.'
  ),
  resumeDelayMs: z.number().step(1).min(0).default(5000).description(
    'Grace period after startup before the interrupted-session scan, so session persistence binds and reconnecting browser tabs open their sessions first.'
  ),
  resumeWindowMs: z.number().step(1).min(0).default(86400000).description(
    'Only session logs modified within this window are considered for resume. Keeps a boot from resuming ancient interrupted logs. 0 = no window.'
  ),
  resumeMax: z.number().step(1).min(0).default(5).description(
    'Maximum interrupted sessions resumed per startup. 0 = unlimited.'
  ),
  resumeDryRun: z.boolean().default(false).description(
    'Log what the restart scan would reopen without reopening anything. Useful to verify candidate selection on a throwaway server instance.'
  ),
  restorePendingMessages: z.boolean().default(true).description(
    'Restore user messages that were queued while a turn was running and then durably canceled by the shutdown, and re-queue them after the session resumes. Without this the shutdown\'s inbox cancel loses input the user already sent.'
  ),
  resumeJobLimit: z.number().step(1).min(0).default(5).description(
    'How many unfinished background jobs to name in the resume context. The processes are gone; naming them is what lets the model decide what to re-launch. 0 = omit from the prompt (the notice still names a few).'
  ),
  resumeSubagentLimit: z.number().step(1).min(0).default(5).description(
    'How many subagent sessions opened from the resumed session to name in the resume context. 0 = omit.'
  )
})

/** Model-facing round instruction, kept self-contained in session history. */
function renderRoundPrompt(round, maxRounds, marker) {
  const budget = maxRounds > 0 ? `${round}/${maxRounds}` : `${round}/unlimited`
  return [
    '<autocontinue>',
    `Round ${budget}. No human is watching this session; keep it moving yourself.`,
    '',
    '- Treat the workspace, the session history, and tool results as authoritative.',
    '  Re-inspect anything you are unsure about instead of trusting earlier narration.',
    '- Take the next concrete step and verify the result.',
    '- Do not repeat destructive or state-changing steps that already succeeded.',
    `- If the assignment is complete, reply with a short final summary whose last line is exactly: ${marker}`,
    '- Otherwise keep going; this loop supplies another round.',
    '</autocontinue>'
  ].join('\n')
}

/** One-line, length-bounded rendering of a job label or command. */
function shorten(text, max) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim()
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`
}

/**
 * Model-facing instruction for a session cut off by a server restart. The
 * concrete turn/step tells the model where the durable log ends, and the job
 * and subagent lists tell it what it no longer has after the process died —
 * the two things a resumed agent cannot know from the transcript alone.
 */
function renderResumePrompt(marker, context) {
  const where = context?.turn !== undefined
    ? `turn ${context.turn}${context.step !== undefined ? `, step ${context.step}` : ''}`
    : 'its last step'
  const lines = [
    '<autocontinue>',
    `The dsh server process was restarted while this session was working (${where}). The interruption was infrastructure — an update or a crash — not a verdict on the plan or the work.`,
    '',
    '- Do not spend time investigating the restart or re-planning from scratch; the session history and the workspace are authoritative.',
    '- Background jobs and other processes owned by the previous server process did NOT survive. Do not wait on them; re-launch what is still needed.',
    '- Do not repeat destructive or state-changing steps that already succeeded.',
    `- Continue from ${where}: take the next concrete step and verify its result.`
  ]
  if (context?.jobs?.length) {
    lines.push('', 'Background jobs registered when the process died (their processes are gone):')
    for (const job of context.jobs) {
      lines.push(`- ${job.kind ?? 'job'} ${job.jobId ?? ''}: ${shorten(job.label ?? '', 140)}`.replace(' :', ':'))
    }
  }
  if (context?.subagents?.length) {
    lines.push('', 'Subagent sessions opened from this session (their work may be incomplete):')
    for (const child of context.subagents) {
      lines.push(`- ${child.id} (${child.agentPreset ?? 'standard'}) — ${child.cwd ?? 'unknown cwd'}`)
    }
  }
  lines.push(
    `- If the assignment is complete, reply with a short final summary whose last line is exactly: ${marker}`,
    '</autocontinue>'
  )
  return lines.join('\n')
}

/** Model-facing retry instruction after a failed turn. */
function renderRetryPrompt(round, attempt, failure, marker) {
  return [
    '<autocontinue>',
    `Round ${round}. The previous turn failed before it could finish — most likely a transient provider or network failure, not a problem with the plan.`,
    `Failure: ${failure}`,
    `Retry attempt ${attempt}.`,
    '',
    '- Wait for the connection to recover, then retry the action that failed.',
    '- Do not restart completed work; do not repeat destructive steps that already succeeded.',
    '- If it keeps failing, say what is blocked and stop for this round; the loop will retry with backoff.',
    `- When the assignment is complete, end with exactly: ${marker}`,
    '</autocontinue>'
  ].join('\n')
}

/** Flatten the text blocks of one message. */
function textOf(message) {
  const blocks = message?.content
  if (!Array.isArray(blocks)) return ''
  return blocks
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim()
}

/** Human-readable rendering of an unknown thrown value. */
function renderThrown(value) {
  if (value instanceof Error) return value.message
  if (value && typeof value === 'object' && typeof value.message === 'string') return value.message
  return String(value)
}

/** One-line rendering of a structured turn failure. */
function renderFailure(failure) {
  if (failure === undefined || failure === null) return 'unknown failure'
  const code = typeof failure.code === 'string' ? failure.code : undefined
  const message = typeof failure.message === 'string' ? failure.message : renderThrown(failure)
  return code !== undefined && code !== '' ? `${code}: ${message}` : message
}

/**
 * Build a client-visible notice message.
 *
 * This is the harness's own idiom for "something happened that the human should
 * see, but which is not a turn" — the model-switch banner uses it: a user
 * message whose source declares `form: 'notice'` with a bounded summary.
 *
 * Delivery is deliberately NOT `agent.inbox.prepend('next-step', …)`: measured
 * on 0.2.0-rc.2, a notice prepended right after `agent.followup()` races the
 * step that is already assembling and is silently dropped (the arm notice
 * survived only because it was posted while the agent was still idle). Notices
 * are therefore queued per agent and appended to the step's own message list by
 * the `agent/pre-step` hook below — exactly how `dsh-agent` injects its
 * model-switch notice — which cannot race.
 *
 * @param text - one-line account, bounded for the collapsed row.
 * @returns a fresh notice message for one step.
 */
function noticeMessage(text) {
  return createUserMessage({
    content: [{ type: 'text', text: `[autocontinue] ${text}` }],
    source: {
      kind: 'autocontinue',
      form: 'notice',
      summary: boundContextSummary(text)
    }
  })
}

/** Install automatic continuation with retry, commands, and teardown. */
export function apply(ctx, config) {
  /** Per-agent runtime state; keyed by the exact live agent. */
  const states = new Map()

  /** Per-agent queued notice texts, drained by the `agent/pre-step` hook. */
  const pendingNotices = new Map()


  /** Gated trace of every lifecycle decision, for when the loop misbehaves. */
  function debug(text) {
    if (!config.debug) return
    try {
      appendFileSync(config.debugFile, `${new Date().toISOString()} ${text}\n`)
    } catch {
      /* a debug sink must never break the loop */
    }
  }

  debug(`apply() entered; version=${version}; pid=${process.pid}; agents=${safeAgentIds()}`)

  /** Comma-joined ids of the currently live agents. */
  function safeAgentIds() {
    try {
      return ctx.agents.list().map((agent) => agent.id).join(',') || 'none'
    } catch (error) {
      return `unreadable (${renderThrown(error)})`
    }
  }

  function stateFor(agent) {
    let state = states.get(agent)
    if (state !== undefined) return state
    state = {
      agent,
      armed: false,
      armReason: 'unarmed',
      rounds: 0,
      retries: 0,
      goalRevives: 0,
      lastGoalRounds: -1,
      queuedId: undefined,
      queuedRound: 0,
      timer: undefined,
      waitingUntil: undefined,
      nextKind: 'continue',
      lastFailure: undefined,
      stopped: false,
      resume: false,
      resumeContext: undefined
    }
    states.set(agent, state)
    return state
  }

  function log(level, text) {
    const logger = ctx.logger
    if (logger?.[level] !== undefined) logger[level](`autocontinue: ${text}`)
    debug(`${level}: ${text}`)
  }

  /** Post a chat notice for a state change; a notice must never break the loop. */
  function notify(state, text) {
    if (!config.notices) return
    const agent = state.agent
    const queue = pendingNotices.get(agent) ?? []
    queue.push(text)
    // A flapping session can queue several; keep the newest few so one step is
    // never buried under notices.
    while (queue.length > 4) queue.shift()
    pendingNotices.set(agent, queue)
    debug(`notice queued: ${text}`)
  }

  /** The goal service, when this profile mounts dsh-goal. */
  function goalService() {
    try {
      return ctx.get('goals')
    } catch {
      return undefined
    }
  }

  /** Current goal for an exact live agent, when the service exists. */
  function goalOf(agent) {
    const goals = goalService()
    if (goals === undefined) return undefined
    try {
      return goals.get(agent)
    } catch {
      return undefined
    }
  }

  /** Whether a mounted goal round driver already owns this session's rounds. */
  function driverOwns(agent) {
    const goal = goalOf(agent)
    return goal !== undefined && goal.phase === 'active' && goal.activation === 'armed'
  }

  /**
   * Take the goal's activation edge back so a goal session never stalls.
   *
   * A goal stops being driven for reasons that have nothing to do with the
   * objective: the round driver disarms it on `agent/error` (so a flaky uplink
   * ends the goal's own retries), and a session resume or fork deliberately
   * leaves it disarmed. Both leave `phase: 'active'` with a spent activation.
   * `goalService().resume()` is the sanctioned way back and carries no
   * caller-authority gate, but it refuses a goal whose round budget is spent, so
   * capacity is checked first.
   *
   * Deliberately NOT revived: `blocked` — that is the model or the goal-tool
   * policy saying the work cannot proceed, and overriding it would fight the
   * loop the harness already has for repeated blocking. `complete` is finished.
   *
   * @param state - the agent whose goal should be re-armed.
   * @returns whether a revival actually happened.
   */
  function reviveGoal(state) {
    if (!config.reviveGoals || !state.armed) return false
    const goals = goalService()
    if (goals === undefined) return false
    const goal = goalOf(state.agent)
    if (goal === undefined) return false
    if (goal.phase !== 'active' && goal.phase !== 'paused') return false
    // Already being driven: nothing to take back.
    if (goal.phase === 'active' && goal.activation === 'armed') return false
    // A spent budget makes resume throw; leave the decision to the goal tools.
    if (goal.roundsStarted >= goal.maxGoalRounds) return false
    // Real progress since the last revival resets the ping-pong guard.
    if (goal.roundsStarted !== state.lastGoalRounds) {
      state.lastGoalRounds = goal.roundsStarted
      state.goalRevives = 0
    }
    if (config.maxGoalRevives > 0 && state.goalRevives >= config.maxGoalRevives) {
      log('warn', `goal "${goal.id}" has been revived ${state.goalRevives} times without starting a round; leaving it ${goal.phase}/${goal.activation}`)
      return false
    }
    const was = `${goal.phase}/${goal.activation}`
    try {
      goals.resume(state.agent, { id: goal.id, revision: goal.revision })
    } catch (error) {
      debug(`goal resume failed for "${goal.id}": ${renderThrown(error)}`)
      return false
    }
    state.goalRevives += 1
    log('info', `revived goal "${goal.id}" (was ${was}, revive ${state.goalRevives})`)
    notify(state, `goal was ${was} — re-armed it (revive ${state.goalRevives}), so the objective keeps moving`)
    return true
  }

  /** Arm continuation without ever double-queueing a round. */
  function arm(state, reason) {
    if (state.armed) return false
    state.armed = true
    state.armReason = reason
    log('info', `armed agent "${state.agent.id}" (${reason})`)
    notify(state, `armed (${reason}) — this session keeps taking rounds until the model reports completion or /autocontinue off`)
    return true
  }

  function disarm(state, reason) {
    clearTimer(state)
    if (!state.armed) {
      state.armReason = reason
      return false
    }
    state.armed = false
    state.armReason = reason
    log('info', `disarmed agent "${state.agent.id}" (${reason})`)
    return true
  }

  function clearTimer(state) {
    if (state.timer === undefined) return
    clearTimeout(state.timer)
    state.timer = undefined
    state.waitingUntil = undefined
  }

  /** Whether this exact agent is still the live one the state was built for. */
  function isLive(state) {
    return !state.stopped && ctx.agents.get(state.agent.id) === state.agent
  }

  /** Delay before the next round, from the pending decision. */
  function pendingDelay(state) {
    if (state.nextKind !== 'retry') return config.idleDelayMs
    const exponent = Math.max(0, state.retries - 1)
    const grown = config.retryBaseDelayMs * 2 ** Math.min(exponent, 16)
    return Math.min(grown, Math.max(config.retryMaxDelayMs, config.retryBaseDelayMs))
  }

  /** Queue exactly one follow-up round when the agent is genuinely idle. */
  function queueRound(state) {
    const agent = state.agent
    if (!state.armed) return debug(`queue skipped: not armed (${state.armReason})`)
    if (!isLive(state)) return debug('queue skipped: agent is no longer live')
    if (state.queuedId !== undefined) return debug('queue skipped: a round is already queued')
    if (agent.status !== 'idle') return debug(`queue skipped: agent status is "${agent.status}"`)
    // A goal session must never be left un-driven: re-arm a goal that stopped
    // being driven (disarmed after a failure, or left disarmed by a resume/fork)
    // or was paused. A successful revival hands the rounds back to the goal
    // round driver, which the next check then defers to.
    if (reviveGoal(state)) return
    if (driverOwns(agent)) return debug('queue skipped: an armed goal round driver owns the rounds')
    if (config.maxRounds > 0 && state.rounds >= config.maxRounds) {
      disarm(state, `round limit ${config.maxRounds} reached`)
      return
    }
    const round = state.rounds + 1
    const retrying = state.nextKind === 'retry'
    const resuming = state.resume === true
    const text = resuming
      ? renderResumePrompt(config.doneMarker, state.resumeContext)
      : retrying
        ? renderRetryPrompt(round, state.retries, renderFailure(state.lastFailure), config.doneMarker)
        : renderRoundPrompt(round, config.maxRounds, config.doneMarker)
    const message = createUserMessage({
      content: [{ type: 'text', text }],
      source: {
        kind: 'autocontinue',
        round,
        retry: retrying
      }
    })
    try {
      agent.followup(message)
    } catch (error) {
      log('warn', `could not queue round ${round} for agent "${agent.id}": ${renderThrown(error)}`)
      return
    }
    const failureText = retrying ? renderFailure(state.lastFailure) : undefined
    state.queuedId = message.id
    state.queuedRound = round
    state.nextKind = 'continue'
    state.lastFailure = undefined
    state.resume = false
    state.resumeContext = undefined
    log('info', `agent "${agent.id}" round ${round}${retrying ? ` (retry ${state.retries})` : ''} queued`)
    if (retrying) {
      notify(state, `previous turn failed (${failureText}) — retry ${state.retries} queued, next backoff up to ${Math.round(config.retryMaxDelayMs / 1000)}s`)
    }
  }

  /** Coalesce every trigger onto one pending timer. */
  function schedule(state, delay) {
    if (!state.armed) return debug(`schedule skipped: not armed (${state.armReason})`)
    if (!isLive(state)) return debug('schedule skipped: agent is no longer live')
    if (state.timer !== undefined) return debug('schedule skipped: a timer is already pending')
    if (state.queuedId !== undefined) return debug('schedule skipped: a round is already queued')
    const wait = Math.max(0, delay)
    debug(`scheduling round in ${wait}ms (rounds=${state.rounds}, retries=${state.retries}, kind=${state.nextKind})`)
    if (wait === 0) {
      queueRound(state)
      return
    }
    // Deliberately NOT unref'd: a pending round is real outstanding work, so it
    // must hold a one-shot/headless process open until the round is queued.
    state.timer = setTimeout(() => {
      state.timer = undefined
      state.waitingUntil = undefined
      queueRound(state)
    }, wait)
    state.waitingUntil = Date.now() + wait
  }

  /** Last assistant text, which is where the done marker would appear. */
  function lastAssistantText(agent) {
    let messages
    try {
      messages = agent.session.deriveMessages()
    } catch (error) {
      log('warn', `could not read history for agent "${agent.id}": ${renderThrown(error)}`)
      return ''
    }
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index]
      if (message?.role !== 'assistant') continue
      const text = textOf(message)
      if (text !== '') return text
    }
    return ''
  }

  /** Decide the next move after a turn ends. */
  function afterTurnEnd(state, reason) {
    const kind = reason?.kind ?? 'completed'
    state.queuedId = undefined
    state.queuedRound = 0
    clearTimer(state)
    debug(`turn/end kind=${kind}${kind === 'error' ? ` failure=${renderFailure(reason.error)}` : ''}`)
    if (!state.armed) return debug('turn/end ignored: not armed')
    if (kind === 'aborted') {
      disarm(state, 'turn was aborted')
      return
    }
    if (kind === 'blocked') {
      disarm(state, 'turn was blocked')
      return
    }
    if (kind === 'error') {
      state.retries += 1
      state.lastFailure = reason.error
      state.nextKind = 'retry'
      if (config.maxRetries > 0 && state.retries > config.maxRetries) {
        disarm(state, `giving up after ${config.maxRetries} retries (${renderFailure(reason.error)})`)
        return
      }
      log('warn', `agent "${state.agent.id}" turn failed (${renderFailure(reason.error)}); retry ${state.retries} scheduled`)
      schedule(state, pendingDelay(state))
      return
    }
    if (kind === 'completed') {
      state.retries = 0
      state.nextKind = 'continue'
      const marker = config.doneMarker.trim()
      if (marker !== '' && lastAssistantText(state.agent).includes(marker)) {
        disarm(state, 'model reported completion')
        return
      }
    } else {
      // max-tokens and anything else recoverable: another round is the right move.
      state.nextKind = 'continue'
    }
    schedule(state, pendingDelay(state))
  }

  /** Render the `/autocontinue status` report. */
  function renderStatus(state) {
    const goal = goalOf(state.agent)
    const lines = [
      `autocontinue v${version} (loaded module generation; a dsh process keeps the one it booted with)`,
      `autocontinue: ${state.armed ? 'ARMED' : 'off'} (${state.armReason})`,
      `rounds: ${state.rounds}${config.maxRounds > 0 ? `/${config.maxRounds}` : ' (unlimited)'}`,
      `consecutive failures: ${state.retries}${config.maxRetries > 0 ? `/${config.maxRetries}` : ' (retry forever)'}`,
      `agent status: ${state.agent.status}`,
      `backoff ceiling: ${config.retryMaxDelayMs}ms`,
      `done marker: ${config.doneMarker}`
    ]
    if (state.queuedId !== undefined) lines.push(`queued: round ${state.queuedRound}`)
    else if (state.timer !== undefined) lines.push(`waiting: ${Math.max(0, (state.waitingUntil ?? Date.now()) - Date.now())}ms before the next round`)
    if (state.lastFailure !== undefined) lines.push(`last failure: ${renderFailure(state.lastFailure)}`)
    if (goal !== undefined && state.armed) {
      lines.push(`goal: ${goal.phase}/${goal.activation} — ${driverOwns(state.agent) ? 'goal round driver owns the rounds' : 'autocontinue owns the rounds'}`)
      if (config.reviveGoals) {
        lines.push(`goal revivals: ${state.goalRevives}${config.maxGoalRevives > 0 ? `/${config.maxGoalRevives}` : ' (unlimited)'}`)
      }
    }
    return lines.join('\n')
  }

  /** `/autocontinue [on|off|status|reset]` */
  function handleCommand(invocation) {
    const state = stateFor(invocation.agent)
    const verb = String(invocation.rawInput ?? '').trim().toLowerCase().split(/\s+/)[0] ?? ''
    debug(`command verb="${verb}"`)
    switch (verb) {
      case '':
      case 'status':
        return { kind: 'success', text: renderStatus(state) }
      case 'on':
      case 'arm':
        arm(state, 'armed by /autocontinue')
        schedule(state, config.idleDelayMs)
        return { kind: 'success', text: renderStatus(state) }
      case 'off':
      case 'stop':
        disarm(state, 'disarmed by /autocontinue')
        return { kind: 'success', text: renderStatus(state) }
      case 'reset':
        state.rounds = 0
        state.retries = 0
        state.goalRevives = 0
        state.lastGoalRounds = -1
        state.lastFailure = undefined
        return { kind: 'success', text: renderStatus(state) }
      default:
        return { kind: 'error', text: `usage: /autocontinue [on|off|status|reset] (got "${verb}")` }
    }
  }

  /** File recording the process generation that last ran the restart scan. */
  const lastPidFile = () => join(homedir(), '.dsh', 'autocontinue', 'last-pid')

  /**
   * Whether this apply is the first one in a new server process. A hot plugin
   * reload re-runs apply() in the same pid; running the restart scan there
   * would mistake live in-flight turns for interrupted ones and post spurious
   * "server restarted" notices.
   */
  function freshProcessGeneration() {
    try {
      mkdirSync(join(homedir(), '.dsh', 'autocontinue'), { recursive: true })
      let previous
      try {
        previous = Number(readFileSync(lastPidFile(), 'utf8').trim())
      } catch {
        previous = undefined
      }
      writeFileSync(lastPidFile(), `${process.pid}\n`)
      return previous !== process.pid
    } catch (error) {
      debug(`could not record process generation: ${renderThrown(error)}`)
      return true
    }
  }

  /** Per-session seq of the interrupt-cancel batch already restored. */
  const restoreStateFile = () => join(homedir(), '.dsh', 'autocontinue', 'restored-seqs.json')

  function readRestoreSeq(sessionId) {
    try {
      const value = JSON.parse(readFileSync(restoreStateFile(), 'utf8'))?.[sessionId]
      return Number.isSafeInteger(value) ? value : 0
    } catch {
      return 0
    }
  }

  function writeRestoreSeq(sessionId, seq) {
    if (!Number.isSafeInteger(seq)) return
    try {
      let state = {}
      try {
        state = JSON.parse(readFileSync(restoreStateFile(), 'utf8'))
      } catch {
        /* a missing or malformed file starts clean */
      }
      state[sessionId] = seq
      mkdirSync(join(homedir(), '.dsh', 'autocontinue'), { recursive: true })
      writeFileSync(`${restoreStateFile()}.tmp`, `${JSON.stringify(state, null, 2)}\n`)
      renameSync(`${restoreStateFile()}.tmp`, restoreStateFile())
    } catch (error) {
      debug(`could not persist restore seq for "${sessionId}": ${renderThrown(error)}`)
    }
  }

  /**
   * Session-log mtimes touched within the window, keyed by session id without
   * its `session-` prefix. Cheap pre-filter over `~/.dsh/sessions`: the corpus
   * has hundreds of sessions, and only recently written logs can hold an open
   * turn from the process that just died.
   */
  async function recentSessionMtimes(windowMs) {
    const root = join(homedir(), '.dsh', 'sessions')
    const cutoff = windowMs > 0 ? Date.now() - windowMs : 0
    const byKey = new Map()
    let workspaces
    try {
      workspaces = await readdir(root, { withFileTypes: true })
    } catch {
      return byKey
    }
    for (const workspace of workspaces) {
      if (!workspace.isDirectory()) continue
      const workspaceDir = join(root, workspace.name)
      let sessions
      try {
        sessions = await readdir(workspaceDir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const session of sessions) {
        if (!session.isDirectory()) continue
        const sessionDir = join(workspaceDir, session.name)
        let files
        try {
          files = await readdir(sessionDir, { withFileTypes: true })
        } catch {
          continue
        }
        for (const file of files) {
          if (!file.isFile() || !/^session\.v\d+\.jsonl\.zstd$/.test(file.name)) continue
          let info
          try {
            info = await stat(join(sessionDir, file.name))
          } catch {
            continue
          }
          if (cutoff > 0 && info.mtimeMs < cutoff) continue
          const key = session.name.replace(/^session-/, '')
          const previous = byKey.get(key) ?? 0
          if (info.mtimeMs > previous) byKey.set(key, info.mtimeMs)
        }
      }
    }
    return byKey
  }

  /** Whether the live inbox projection already holds a pending message id. */
  function livePendingIds(agent) {
    const ids = new Set()
    try {
      const projections = ctx.get('sessionProjections')
      const inbox = projections?.stateOf(agent.session, 'inbox')
      if (inbox !== undefined) {
        for (const message of [...inbox['next-turn'], ...inbox['next-step']]) ids.add(message.id)
      }
    } catch {
      /* an unreadable projection just means "restore nothing twice" */
    }
    return ids
  }

  /**
   * Re-queue input the shutdown canceled. The harness durably cancels pending
   * inbox items when the process disposes, so a user message sent during a
   * turn is otherwise gone after a restart even though the transcript shows it
   * was typed. A crashed process left the items in the projection instead;
   * checking the live projection keeps both paths from duplicating input.
   */
  function restorePending(agent, messages) {
    if (!config.restorePendingMessages || messages.length === 0) return 0
    const live = livePendingIds(agent)
    const seen = new Set()
    let restored = 0
    for (const message of messages) {
      if (restored >= 5) break
      if (message?.source?.kind === 'autocontinue') continue
      const text = textOf(message)
      if (text === '' || seen.has(text) || live.has(message.id)) continue
      seen.add(text)
      try {
        agent.followup(createUserMessage({
          content: message.content,
          source: message.source ?? { kind: 'user' }
        }))
        restored += 1
      } catch (error) {
        log('warn', `could not restore a pending message for "${agent.id}": ${renderThrown(error)}`)
      }
    }
    if (restored > 0) log('info', `restored ${restored} pending message(s) for "${agent.id}"`)
    return restored
  }

  /**
   * Reopen one interrupted session and queue its continuation round.
   *
   * The raw persisted log is read through the persistence service — the same
   * read the harness's own resume path uses before it appends its synthetic
   * `interrupted` closers. (The session-query read cannot be used here: it
   * balances the log in memory, so an open turn looks closed.) `resolveAgent`
   * is the Web GUI's attach path: it balances the stored tail, re-composes the
   * session's agent preset, and publishes the agent. The goal round driver (or
   * `reviveGoal`) then takes the rounds for a goal session; every other
   * interrupted session gets a resume round from here.
   */
  async function resumeOne(scanCtx, candidate) {
    const persistence = scanCtx.sessionPersistence
    const controller = scanCtx.sessionController
    if (persistence === undefined || controller === undefined) return false
    let handle
    let outcome
    try {
      handle = await persistence.open(candidate.id, 'read')
      const { events } = await handle.read(0)
      outcome = resumeState(events, readRestoreSeq(candidate.id))
    } catch (error) {
      log('warn', `resume scan could not read "${candidate.id}": ${renderThrown(error)}`)
      return false
    } finally {
      try {
        await handle?.close()
      } catch {
        /* a read handle must never break the loop */
      }
    }
    if (!outcome.interrupted && !(config.resumeGoalSessions && outcome.goal !== undefined)) return false
    const live = ctx.agents.get(candidate.id)
    if (live !== undefined && (live.status === 'running' || !outcome.interrupted)) {
      // A live agent that is already working (or whose turn closed) must not be
      // told the server restarted. Only reconnect its shutdown-canceled queued
      // input; a cancel is the one thing a live reload cannot have produced.
      let restored = 0
      if (outcome.recoverable.length > 0) restored = restorePending(live, outcome.recoverable)
      if (outcome.restoreSeq !== undefined) writeRestoreSeq(candidate.id, outcome.restoreSeq)
      if (restored > 0) {
        notify(stateFor(live), `restored ${restored} pending message(s) the shutdown had canceled`)
        log('info', `restored ${restored} pending message(s) for live session "${candidate.id}"`)
      }
      return false
    }
    const allSubagents = (candidate.children ?? [])
      .filter((child) => (child.createdAt ?? 0) > outcome.lastSeedTime)
      .sort((left, right) => (right.createdAt ?? 0) - (left.createdAt ?? 0))
    const subagents = allSubagents.slice(0, config.resumeSubagentLimit)
    const allJobs = outcome.jobs
    const jobs = allJobs.slice(0, config.resumeJobLimit)
    const recoverable = [...outcome.recoverable, ...outcome.pending]
    if (config.resumeDryRun) {
      log('info', `resume dry-run: would resume session "${candidate.id}" (${candidate.cwd}; ${outcome.interrupted ? `interrupted at ${outcome.turn === undefined ? 'turn ?' : `turn ${outcome.turn}`}${outcome.step === undefined ? '' : `, step ${outcome.step}`}` : 'active goal'}); ${jobs.length} job(s), ${subagents.length} subagent(s), ${recoverable.length} pending message(s)`)
      return false
    }
    try {
      const result = await controller.agents.resolveAgent(candidate.id)
      if (result?.error !== undefined) {
        log('warn', `could not resume "${candidate.id}": ${renderThrown(result.error)}`)
        return false
      }
      const agent = result?.agent
      if (agent === undefined || agent.id !== candidate.id) {
        log('warn', `resume of "${candidate.id}" returned no agent`)
        return false
      }
      const state = stateFor(agent)
      state.resume = outcome.interrupted
      state.resumeContext = { turn: outcome.turn, step: outcome.step, jobs, subagents }
      arm(state, outcome.interrupted ? 'resumed an interrupted run after restart' : 'resumed an active goal session after restart')
      const where = outcome.turn === undefined
        ? 'a turn'
        : `turn ${outcome.turn}${outcome.step === undefined ? '' : `, step ${outcome.step}`}`
      const lost = []
      if (allJobs.length > 0) lost.push(`${allJobs.length} background job(s)`)
      if (allSubagents.length > 0) lost.push(`${allSubagents.length} subagent(s)`)
      const lostText = lost.length > 0 ? `; ${lost.join(' and ')} from the old process are gone` : ''
      if (outcome.interrupted) {
        notify(state, `dsh server restarted mid-run (${where})${lostText} — continuing from there`)
      } else {
        notify(state, `dsh server restarted; resuming the active goal "${shorten(outcome.goal?.objective ?? '', 70)}"`)
      }
      const restored = restorePending(agent, recoverable)
      if (outcome.restoreSeq !== undefined) writeRestoreSeq(candidate.id, outcome.restoreSeq)
      if (restored > 0) notify(state, `restored ${restored} pending message(s) the shutdown had canceled`)
      if (allJobs.length > 0) {
        const labels = allJobs.slice(0, 3).map((job) => `${job.kind ?? 'job'} "${shorten(job.label ?? '', 55)}"`).join('; ')
        notify(state, `jobs that did not survive: ${labels}${allJobs.length > 3 ? ` (+${allJobs.length - 3} more)` : ''}`)
      }
      if (allSubagents.length > 0) {
        notify(state, `subagent sessions opened from here: ${allSubagents.slice(0, 3).map((child) => child.id).join(', ')}${allSubagents.length > 3 ? ' …' : ''}`)
      }
      schedule(state, config.resumeDelayMs)
      log('info', `resumed ${outcome.interrupted ? 'interrupted' : 'active-goal'} session "${candidate.id}" (${candidate.cwd})`)
      return true
    } catch (error) {
      log('warn', `resume failed for "${candidate.id}": ${renderThrown(error)}`)
      return false
    }
  }

  /**
   * Find sessions cut off by a restart and reopen them, so their work continues
   * without a browser tab being open. Runs once per process generation, after
   * the configured settle delay; every per-session failure is contained.
   */
  async function resumeInterruptedRuns(scanCtx) {
    if (!config.resumeUnfinished) return
    const persistence = scanCtx.sessionPersistence
    if (persistence === undefined) return
    let snapshots = []
    try {
      snapshots = await persistence.list()
    } catch (error) {
      log('warn', `resume scan could not list sessions: ${renderThrown(error)}`)
      return
    }
    const childrenByParent = new Map()
    for (const snapshot of snapshots) {
      const parent = snapshot.header.parentSession
      if (parent === undefined) continue
      const list = childrenByParent.get(parent) ?? []
      list.push(snapshot.header)
      childrenByParent.set(parent, list)
    }
    const recent = await recentSessionMtimes(config.resumeWindowMs)
    const candidates = []
    for (const snapshot of snapshots) {
      const header = snapshot.header
      if (!header.cwd) continue
      if (header.delegationDepth !== undefined && header.delegationDepth > 0) continue
      if (header.origin === 'subagent') continue
      if (snapshot.formatStatus === 'migration-required') continue
      const key = header.id.replace(/^session-/, '')
      const mtime = recent.get(key)
      if (mtime === undefined) continue
      candidates.push({ id: header.id, cwd: header.cwd, mtime, children: childrenByParent.get(header.id) ?? [] })
    }
    candidates.sort((left, right) => right.mtime - left.mtime)
    const limit = config.resumeMax > 0 ? config.resumeMax : candidates.length
    let resumed = 0
    for (const candidate of candidates) {
      if (resumed >= limit) break
      if (await resumeOne(scanCtx, candidate)) resumed += 1
    }
    debug(`resume scan: ${snapshots.length} sessions, ${candidates.length} recent, ${resumed} resumed`)
    if (resumed > 0) log('info', `resumed ${resumed} interrupted session(s) after restart`)
  }

  ctx.effect(function* () {
    debug('effect mounted')

    const disposeCommand = ctx.commands.register({
      name: 'autocontinue',
      description: 'Keep this session moving on its own; retry failed turns with backoff.',
      input: { hint: 'on | off | status | reset' },
      handler: handleCommand
    })


    // Deliver queued notices by appending them to the step's own message list.
    // This mirrors `dsh-agent`'s model-switch notice and cannot race the inbox:
    // a step either runs (and carries the notices) or it does not (and the
    // notices wait for the next one).
    ctx.on('agent/pre-step', async ({ agent }, next) => {
      const pending = pendingNotices.get(agent)
      const decision = await next()
      if (pending === undefined || pending.length === 0) return decision
      if (decision.kind !== 'enter') return decision
      pendingNotices.delete(agent)
      return { ...decision, messages: [...decision.messages, ...pending.map(noticeMessage)] }
    })

    ctx.on('agent/created', ({ agent }) => {
      debug(`agent/created "${agent.id}"`)
      const state = stateFor(agent)
      state.stopped = false
      if (config.enabled) arm(state, 'profile default')
      else if (config.goalSessions && goalOf(agent) !== undefined) arm(state, 'session already has a goal')
    })

    ctx.on('goal/changed', ({ agent }) => {
      if (!config.goalSessions) return
      const state = stateFor(agent)
      if (!state.armed && goalOf(agent) !== undefined) arm(state, 'goal appeared in this session')
      else if (state.armed) schedule(state, config.idleDelayMs)
    })

    ctx.on('agent/status', ({ agent, status }) => {
      const state = stateFor(agent)
      debug(`agent/status "${status}" armed=${state.armed}`)
      if (status !== 'idle') return
      if (!state.armed) return
      schedule(state, pendingDelay(state))
    })

    ctx.on('agent/error', ({ agent, error }) => {
      // Diagnostic only. A failed turn emits `agent/error` FIRST and then
      // `turn/end` carrying the same structured failure, so counting or
      // scheduling here burns two retry credits for one outage.
      const state = states.get(agent)
      if (state === undefined || !state.armed) return
      debug(`agent/error observed (${renderFailure(error)}); the turn/end owns the retry count`)
    })

    ctx.on('agent/disposed', ({ agent }) => {
      debug(`agent/disposed "${agent.id}"`)
      const state = states.get(agent)
      if (state !== undefined) clearTimer(state)
      states.delete(agent)
      pendingNotices.delete(agent)
    })

    ctx.on('session/event', (session, event) => {
      const agent = ctx.agents.get(session.id)
      if (agent === undefined || agent.session !== session) return
      const state = states.get(agent)
      if (state === undefined) return
      switch (event.type) {
        case 'user/message':
          if (state.queuedId !== undefined && event.data.id === state.queuedId) {
            state.rounds = state.queuedRound
            state.queuedId = undefined
            state.queuedRound = 0
            debug(`round ${state.rounds} admitted into history`)
          }
          return
        case 'turn/end':
          afterTurnEnd(state, event.data.reason)
          return
        default:
          return
      }
    })

    const existing = ctx.agents.list()
    debug(`arming existing agents: ${existing.map((agent) => agent.id).join(',') || 'none'}`)
    for (const agent of existing) {
      const state = stateFor(agent)
      if (config.enabled) arm(state, 'profile default')
      else if (config.goalSessions && goalOf(agent) !== undefined) arm(state, 'session already has a goal')
    }

    // Restart recovery: a server swap (dsh-update) or a crash leaves the
    // persisted log ending inside a turn, with no live agent behind it. Reopen
    // those sessions here — the harness appends its interrupted closers on
    // resume, and the round machinery above continues the work even if no
    // browser tab ever reattaches.
    if (config.resumeUnfinished) {
      const fresh = freshProcessGeneration()
      debug(`restart scan ${fresh ? 'scheduled' : 'skipped (live reload; same pid)'}`)
      if (fresh) ctx.inject(['sessionPersistence', 'sessionController'], (scanCtx) => {
        const timer = setTimeout(() => {
          void resumeInterruptedRuns(scanCtx).catch((error) => {
            log('warn', `resume scan failed: ${renderThrown(error)}`)
          })
        }, Math.max(0, config.resumeDelayMs))
        ctx.effect(() => () => clearTimeout(timer), 'autocontinue resume scan timer')
      })
    }

    yield () => {
      debug('effect disposed')
      disposeCommand()
      for (const state of states.values()) {
        state.stopped = true
        clearTimer(state)
        state.armed = false
      }
      states.clear()
      pendingNotices.clear()
    }
  }, 'autocontinue lifecycle')
}
