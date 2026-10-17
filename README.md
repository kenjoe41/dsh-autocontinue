# dsh-autocontinue

A dsh plugin that keeps a session working when nobody is watching: it continues
the conversation on its own, retries through provider and network failures with
backoff, and refuses to let a goal session stall.

**Version 0.1.13** · verified on `dsh 0.2.1-rc.2`.

- [Why](#why)
- [What it does](#what-it-does)
- [Quick start](#quick-start)
- [Behaviour](#behaviour)
  - [1. Continuation](#1-continuation)
  - [2. Retry through outages](#2-retry-through-outages)
  - [3. Goal revival](#3-goal-revival)
- [Working with the goal round driver](#working-with-the-goal-round-driver)
- [Visibility](#visibility)
- [Commands](#commands)
- [Configuration](#configuration)
- [Install and update](#install-and-update)
- [Hard-won notes](#hard-won-notes)

## Why

A long unattended run dies in three boring ways: the model stops after one turn
and waits for a human; the uplink drops and the turn ends in `TRANSPORT`; or a
goal quietly loses its activation edge — the round driver disarms a goal on
error, and a session resume or fork deliberately leaves it disarmed. The work is
still perfectly resumable in all three cases. This plugin resumes it.

## What it does

| | Behaviour |
| --- | --- |
| **Continues** | An armed session's idle agent gets the next round queued for it, instead of waiting for a human to type "continue". |
| **Retries** | A turn that failed on the provider or network is retried forever by default, with exponential backoff that plateaus at a constant 5-minute interval. |
| **Revives** | A goal that stopped being driven — disarmed after a failure, left disarmed by a resume/fork, or paused — is re-armed so the objective keeps moving. |

Nothing runs until a session is **armed** (see [Quick start](#quick-start)).

## Quick start

```sh
# 1. install into a profile (see Install and update for the why-tarball)
dsh plugin --profile web add /path/to/dsh-autocontinue-0.1.4.tgz

# 2. arm the current session, from the session itself
/autocontinue on
```

Goal sessions arm themselves (`goalSessions: true`). Profiles that launch
sessions rather than a human — cron, headless, "called in" — set
`enabled: true` and get it for every session in that profile.

## Behaviour

### 1. Continuation

When an armed session's agent goes idle, the plugin queues a round: a normal user
message headed `<autocontinue> Round n/…` that tells the model to keep going, to
treat the workspace and tool results as authoritative, and to end its reply with
the done marker when the assignment is genuinely finished. The transcript reads
as an ordinary conversation.

The loop stops when any of these is true: the model ends a reply with the done
marker (`AUTOCONTINUE: DONE`), a turn is aborted (you hit stop — a human
interrupt is respected), `maxRounds` is reached, or you run `/autocontinue off`.

### 2. Retry through outages

Defaults are tuned for an unreliable uplink — retry **forever**, backing off to a
constant 5-minute interval:

| Consecutive failure | Wait before the retry |
| --- | --- |
| 1 | 15 s |
| 2 | 30 s |
| 3 | 60 s |
| 4 | 2 min |
| 5 | 4 min |
| 6+ | **5 min, forever** (unless `maxRetries` is set) |

Each retry round names the exact failure and instructs the model to retry the
action that failed rather than restart completed work. Set `maxRetries` to give
up after N, or leave it at `0` to ride out an outage of any length.

Two implementation facts that matter if you touch this code:

- The retry is driven by `turn/end` with `reason.kind === 'error'` — the turn
  boundary that owns a failed request, carrying the harness's structured
  `LlmFailure` (`TRANSPORT`, `AUTH`, …).
- `agent/error` is deliberately **not** counted. A failed turn emits
  `agent/error` first and then `turn/end` with the same failure; counting both
  burned two retry credits per outage, so `maxRetries: 2` gave up after a single
  real retry. `turn/end` is the only counter.

### 3. Goal revival

A goal stops being driven for reasons unrelated to the objective, and a stalled
goal is worse than a failed turn because nothing retries it:

- the round driver **disarms** a goal on `agent/error`, so one network blip ends
  the goal's own continuation;
- a session **resume or fork** leaves an active goal disarmed by design (the
  driver never revives work on its own);
- the goal can be **paused**.

With `reviveGoals: true` (default), the plugin calls the sanctioned
`ctx.goals.resume(agent, ref)` — which carries no caller-authority gate — and the
goal round driver immediately takes the rounds back, keeping the goal's own
round accounting authoritative.

Deliberately **not** revived:

- **`blocked`** — that is the model, or the goal-tool policy, stating the work
  cannot proceed. Overriding it would fight the harness's own repeated-blocking
  policy.
- A goal whose **round budget is spent** — `resume` would throw; `maxGoalRounds`
  is the goal's decision to make, not this plugin's.

Revivals are capped by `maxGoalRevives` (default 5) so something that keeps
pausing a goal cannot ping-pong with it forever; the counter resets as soon as
the goal actually starts a round. Every revival is announced in the chat.

### 4. Restart recovery

A server swap (the `dsh-update` staged install + reload) or a crash stops the
process while a turn is still open: the persisted log ends inside `turn/start`
with no `turn/end`, and no live agent is left to continue it. On startup this
plugin scans the session corpus, and for every recently-written log that still
ends inside a turn it reopens the session through the same path the Web GUI uses
(`resolveAgent`) and queues a resume round.

That does three things the browser cannot be relied on for:

- the harness appends its synthetic `interrupted` closers, so the old turn is
  balanced instead of looking like a permanently running one;
- the session's agent preset and model selection are recomposed, and the goal
  round driver picks the work back up for a goal session;
- sessions with no browser tab still continue, which is what keeps a switch from
  orphaning work in another workspace.

The resumed session is told exactly what happened so it does not spend a round
working it out: the notice and the resume round name the durable cut
(`turn N, step M`), say the interruption was infrastructure — an update or a
crash — rather than a verdict on the plan, and tell the model not to investigate
it or re-plan from scratch. A goal session gets the same explanation as an
autocontinue notice riding the goal round.

The scan also reconstructs what the dead process owned, because a resumed model
cannot know it from the transcript alone:

- **Pending input.** The harness durably cancels queued inbox messages when the
  process disposes, so a message typed during a turn disappears on restart. The
  scan replays the raw `agent/inbox/spliced` history and re-queues messages
  canceled at that shutdown, deduped against input that is still pending or was
  already admitted (a steer move appears as a cancel plus a re-insert). The
  last handled cancellation seq is persisted per session, so a tab that
  reattaches and appends a fresh `session/end-seed` before the scan cannot hide
  the shutdown cancel behind a new resume marker.
- **Background jobs.** `job/registered` minus `job/settled` from the same
  generation is listed in the resume round. The processes are gone; naming them
  is what lets the model decide what to re-launch.
- **Subagent sessions.** Direct children of the resumed session created in the
  same generation are listed, so their work is not silently orphaned.
- **Active goals.** A session whose latest `goal/change` is `phase: active` with
  rounds left is reopened even when its last turn completed, so the goal round
  driver keeps the objective moving instead of leaving it parked until someone
  opens the workspace. Paused, blocked and complete goals are left alone.

Only logs modified within `resumeWindowMs` are considered, at most `resumeMax`
sessions are resumed per startup, and each session's failure is contained and
logged.

A resume notice looks like:

```
[autocontinue] dsh server restarted mid-run (turn 3, step 12); background jobs
from the old process are gone — continuing from there
```

## Working with the goal round driver

`dsh-base` always mounts `dsh-goal-round-driver`, which continues a session only
while a goal is active **and** armed. Autocontinue defers in exactly that state
(`queue skipped: an armed goal round driver owns the rounds`) so a goal session
never gets double rounds, and takes over when the driver stands down. The two are
complementary: the driver owns *progress*, this plugin owns *persistence*.

## Visibility

### In the chat

Notice rows appear in the transcript, in the same shape the harness uses for its
model-switch banner:

```
[autocontinue] armed (profile default) — this session keeps taking rounds
until the model reports completion or /autocontinue off
```

```
[autocontinue] previous turn failed (TRANSPORT: DeepSeek Messages transport
failed) — retry 2 queued, next backoff up to 300s
```

```
[autocontinue] goal was active/disarmed — re-armed it (revive 1), so the
objective keeps moving
```

A notice is never queued as a turn: it is appended to the step's own message list
by the plugin's `agent/pre-step` hook, so it rides the round that follows and
cannot start a turn of its own. Silence them with `notices: false`.

### On demand

```
/autocontinue status
```

reports armed state, rounds, consecutive failures, the pending wait, the last
failure, the goal's phase/activation, who owns the rounds, and the revival count.

### Debug trace

`debug: true` appends every lifecycle decision — arming, scheduling, each skip
reason, retry accounting, revival attempts — to `debugFile` (default
`/tmp/dsh-autocontinue.log`). This is the tool that found both bugs described in
[Hard-won notes](#hard-won-notes).

## Commands

```
/autocontinue            # status for this session
/autocontinue on|off     # arm / disarm this session
/autocontinue reset      # zero the round, failure and revival counters
```

## Configuration

Every key, with its default. A profile patch **replaces** the whole `config`, so
restate every key you want to keep.

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `false` | Arm every session in this profile. Turn on for launcher/cron/headless profiles. |
| `goalSessions` | `true` | Arm sessions that have a goal. |
| `reviveGoals` | `true` | Re-arm a goal that stopped being driven, or was paused. `blocked` is never overridden. |
| `maxGoalRevives` | `5` | Consecutive revivals before giving up and reporting; resets when the goal starts a round. `0` = unlimited. |
| `maxRounds` | `0` | Continuation rounds per session. `0` = unlimited. |
| `maxRetries` | `0` | Consecutive failure retries. `0` = retry forever. |
| `idleDelayMs` | `0` | Grace period after idle before the next round. Keep `0` for one-shot launchers (see below). |
| `retryBaseDelayMs` | `15000` | First backoff; doubles per consecutive failure. |
| `retryMaxDelayMs` | `300000` | Backoff ceiling (5 min). |
| `doneMarker` | `AUTOCONTINUE: DONE` | Exact last line that stops the loop. |
| `notices` | `true` | Post chat notice rows on arm / retry / revive. |
| `debug` | `false` | Append the decision trace to `debugFile`. |
| `debugFile` | `/tmp/dsh-autocontinue.log` | Where the trace goes. |
| `resumeUnfinished` | `true` | On startup, reopen sessions whose log ends inside an open turn and queue a resume round. |
| `resumeDelayMs` | `5000` | Settle delay before the restart scan, and before the resume round is queued. |
| `resumeWindowMs` | `86400000` | Only logs modified within this window are considered for resume. `0` = no window. |
| `resumeMax` | `5` | Maximum interrupted sessions resumed per startup. `0` = unlimited. |
| `resumeDryRun` | `false` | Log what the restart scan would resume without reopening anything. |
| `resumeGoalSessions` | `true` | Reopen sessions with an active goal even when their last turn completed. |
| `restorePendingMessages` | `true` | Restore user messages the shutdown canceled and queue them after resume. |
| `resumeJobLimit` | `5` | Unfinished background jobs named in the resume prompt. `0` = notice only. |
| `resumeSubagentLimit` | `5` | Subagent sessions named in the resume prompt. `0` = notice only. |

A cron or headless profile usually wants:

```yaml
# <profile>/cordis.patch.yml
- id: autocontinue
  config:
    enabled: true
    goalSessions: true
    reviveGoals: true
    maxGoalRevives: 5
    maxRounds: 0
    maxRetries: 0
    idleDelayMs: 0
    retryBaseDelayMs: 15000
    retryMaxDelayMs: 300000
    doneMarker: 'AUTOCONTINUE: DONE'
    notices: true
```

## Install and update

**Every change bumps `version` in `package.json`.** This package is installed
from GitHub, a packed tarball, or a linked checkout; a version bump is what
makes "which build is actually running?" answerable, and it keeps the plugin
manager's bookkeeping honest.

From GitHub:

```sh
dsh plugin --profile <profile> add github:kenjoe41/dsh-autocontinue
# or pin a release
dsh plugin --profile <profile> add github:kenjoe41/dsh-autocontinue#v0.1.13
```

From a local checkout (maintainers):

```sh
# from this directory
pnpm pack --pack-destination /tmp
dsh plugin --profile <profile> add /tmp/dsh-autocontinue-<version>.tgz
```

Keep the `peerDependencies` in step with the runtime (`dsh -V`): the plugin
manager refuses an install whose peers do not match and rolls the profile back.

For a profile that links this directory instead, edits take effect on the next
reload with no repack:

```sh
dsh plugin --profile <profile> add /path/to/dsh-autocontinue
```

## Hard-won notes

Measured on `dsh 0.2.1-rc.2`, each of these cost a debugging round:

- **`sessionQuery.observeSession` cannot tell you a session was interrupted.**
  The query read balances an open tail in memory (synthetic `turn/end`
  closers), so a scan over its events sees a clean log and resumes nothing —
  the first restart-recovery build found 0 of 2 interrupted sessions this way.
  Read the raw log through `ctx.sessionPersistence.open(id, 'read')`; that is
  the same read the harness's own resume path runs `interruptedTurnClosers` on.
- **A reattaching tab resumes the session before a 5 s scan runs.** The tab's
  attach appends the harness's synthetic `turn/end` with
  `reason.kind === 'interrupted'`, so checking only for an open `turn/start`
  misses exactly the sessions a browser already half-resumed. Treat a log whose
  last turn ended `interrupted` (with no later `turn/start`) as still needing a
  resume round, and do not skip a session just because an agent is already live.
- **The shutdown cancels pending inbox input, durably.** `agent/inbox/spliced`
  entries with `outcome: 'canceled'` are how a queued message is lost; a steer
  move produces the same shape (`canceled` next-turn removal, then a next-step
  insert with the same message id), so a cancel is not proof of loss. Restore a
  canceled message only when it is neither still pending nor present in a
  `user/message` event. Reading the raw persistence log is required: the
  projection and `observeSession` both show the balanced/cancelled state.
  Do not use the last `session/end-seed` as the recovery cutoff — a tab can
  reattach within milliseconds of the restart, and its fresh marker moves the
  cutoff past the very cancel the scan is looking for (this lost the first
  pending-message restore test). Persist the handled cancellation seq instead.
- **Install as a tarball (or link with shims), never a bare directory.** A
  `link:` install makes Node resolve `@deepseek-ai/dsh-llm` from the package's
  *real* path, which is outside the profile, and the plugin dies at import with
  `Cannot find package '@deepseek-ai/dsh-llm'` — silently, as far as the session
  is concerned. This package carries `node_modules/@deepseek-ai/{dsh-llm,schemastery}`
  shims so a linked install resolves too.
- **`idleDelayMs` must be `0` for one-shot launchers.** A headless run disposes
  the whole plugin tree the moment the agent is idle with an empty inbox; with a
  200 ms grace period the timer never fired. At `0` the round is queued inside
  the idle transition and the run continues. A pending round is deliberately
  *not* an unref'd timer, so it holds the process open.
- **Do not deliver notices through `agent.inbox.prepend('next-step', …)`.** A
  notice posted immediately after `agent.followup()` races the step that is
  already assembling and is dropped without a word (the arm notice survived only
  because it was posted while the agent was still idle). Append to the step's
  message list in `agent/pre-step` instead.
- **One failure, one retry credit.** See [Retry through outages](#2-retry-through-outages);
  `agent/error` and `turn/end` describe the same failure.
