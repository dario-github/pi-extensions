---
name: a2a
description: A2A (Agent2Agent) Protocol v1.0 bidirectional communication. Distribute tasks to remote agents (Hermes, ADK, LangChain, CrewAI, any A2A peer) and be called by them. Use when delegating work across agents/machines/frameworks, doing parallel multi-agent fan-out, or when another agent needs to call Pi. Trigger on "a2a", "agent-to-agent", "delegate to another agent", "ask agent X", "call remote agent", "multi-agent", "Hermes", "task distribution".
---

# A2A — Agent-to-Agent Protocol v1.0

Pi as a first-class A2A peer. [A2A](https://a2a-protocol.org) is the open
Linux Foundation standard for inter-agent communication (JSON-RPC 2.0 over
HTTP). This extension makes Pi bidirectional: it can **call other agents** and
**be called by them**.

## When to use

- **Delegating to a specialist** — a peer advertising `web_search`/`research`/
  `coding` skills can be discovered and called mid-conversation.
- **Cross-machine collaboration** — hand a task to a Hermes on a server, each
  with its own memory/tools/credentials.
- **Parallel fan-out** — send one task to every capable peer at once.
- **Being callable** — expose Pi so other frameworks' agents can send it tasks.

For same-machine, in-process delegation (cheaper, shared context) prefer the
`subagent` tool. A2A is for crossing process/machine/framework boundaries.

## Outbound — calling other agents (7 tools)

| Tool | Use |
|------|-----|
| `a2a_discover(url)` | Fetch a peer's Agent Card to learn its capabilities |
| `a2a_call(agent, message, context_id?)` | **Blocking** send: wait for the reply (bounded by the peer's reply window, default 300s). Short tasks only. |
| `a2a_send(agent, message, context_id?)` | **Non-blocking** send (`returnImmediately=true`): returns a task id at once; the peer runs in the background under its `taskTimeoutSec` (default 3600s). Use for anything that may take more than a couple of minutes. |
| `a2a_task(agent, task_id)` | Poll a task from `a2a_send`: `working` → keep polling; `completed`/`failed`/`canceled` → final reply; `input-required` → answer with `a2a_call` on the same `context_id`. |
| `a2a_list()` | Configured peers, persisted conversations, metrics |
| `a2a_history(context_id)` | Recall a persisted conversation |
| `a2a_orchestrate(capability, message, mode?)` | Fan-out to all peers advertising a capability (`all`/`first`/`best`) |

`agent` is a configured peer name (from `a2a.peers` in settings.json), a
gateway-proxied name (`gw/<gateway>/<peer>`), a discovered peer name, or a full
`http(s)://` URL.

**Rule of thumb:** if you cannot say the task finishes in under two minutes,
use `a2a_send` + `a2a_task`. A blocking call that dies at the reply window
reports `failed` and the peer's partial work is discarded — never treat that
as a finished result.

## Inbound — being callable (opt-in)

`/a2a-server start` serves an Agent Card + JSON-RPC endpoint. Each inbound task
spawns an isolated Pi agent session in the workspace and returns the reply as a
task artifact. **Localhost-only by default**; remote needs a token + explicit host.

### Seeing what your own seat received (`a2a_inbox`)

Inbound work runs in **detached child sessions** — it never enters this host
session's context. You learn about it through two bounded channels:

- An `[a2a-inbox]` digest at the start of your next turn (one metadata-only
  message listing tasks that reached a terminal state since your last turn;
  `a2a.inbound.visibility = signal`, the default).
- `a2a_inbox()` lists recent inbound tasks (peer, state, elapsed);
  `a2a_inbox(task_id)` returns the full reply when this process still holds it,
  else the child-session transcript path under `<piDir>/a2a_inbound_sessions/`.

**If you are the child session answering an inbound task** and the outcome
needs the seat's principal (a ruling, a budget approval, a truth-source or
schedule change — NOT fact lookups, receipts or registrations), end your reply
with the literal marker `[NEEDS_PRINCIPAL]`. It is stripped from the reply and
flags the inbox row; on heartbeat seats (or `a2a.inbound.wake = true`) that
row wakes the host — idle → a turn starts now, busy → delivered after the
current turn settles — at most once per `a2a.inbound.wakeMergeSec` (default
300s). Everything else waits for the host's natural next turn.

When a user asks "what came in over a2a?" or a digest appears, call `a2a_inbox`
before answering. The child already did the work — read its outcome, do not
redo it. Set `a2a.inbound.visibility` to `silent` (pull only) or `full`
(every activity line as a message — debugging only, noisy).

## Commands

`/a2a-discover <url>` · `/a2a-agents` · `/a2a-send <agent> <msg>` ·
`/a2a-broadcast <msg> --agents a,b,c` · `/a2a-status` · `/a2a-config` ·
`/a2a-server start|stop|status` · `/a2a-help`

## Security (on by default)

- No token ⇒ localhost-only bind; remote requires token + explicit host.
- Outbound text is scrubbed of credentials; inbound text is injection-filtered
  and framed as untrusted peer input.
- Per-context anti-loop cap; append-only audit log at `<piDir>/a2a_audit.jsonl`.

## Configuration

Peers and server live under the `a2a` key in `~/.pi/agent/settings.json`, or
`A2A_*` env vars. See the package README for the full schema.
