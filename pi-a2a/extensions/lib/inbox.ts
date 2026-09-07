/**
 * Inbound inbox (#27): a per-seat, on-disk, append-only record of every
 * inbound a2a task that reached a terminal state. Bridges the isolation gap —
 * inbound work runs in detached child sessions, so the HOST model would
 * otherwise never learn what its own seat received/answered.
 *
 * Design rules (thinking-notebook 2026-09-07):
 *  - metadata only in anything that auto-enters the host context; reply text
 *    is fetched explicitly via the a2a_inbox tool;
 *  - disk, not memory: one seat may be served by several processes and the
 *    in-memory TaskStore dies with the process;
 *  - digests are bounded (folded past `max`) and only ever injected at a turn
 *    boundary (before_agent_start), never mid-turn.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface InboxEntry {
  ts: string;
  taskId: string;
  contextId: string;
  /** Authenticated caller identity — peer-controlled display string. */
  identity: string;
  state: string;
  elapsedMs: number;
  /** Error text for FAILED tasks (already redacted by the server). */
  error?: string;
  /** Detached child-session transcript path, when known. */
  sessionFile?: string;
  /** The child flagged this outcome as needing the principal (a ruling,
   *  budget approval, truth-source or schedule change) — the only class of
   *  entry allowed to wake the host (#27 E). */
  needsPrincipal?: boolean;
}

const MAX_READ_BYTES = 2 * 1024 * 1024; // ponytail: tail-read cap; rotate when a seat outgrows this

function seatFile(seat: string): string {
  // Filesystem-safe seat key; workstation names are [A-Za-z0-9._-].
  return `${seat.replace(/[^A-Za-z0-9._-]/g, "_") || "default"}.jsonl`;
}

export function inboxPath(piDir: string, seat: string): string {
  return join(piDir, "a2a_inbox", seatFile(seat));
}

export function appendInbox(piDir: string, seat: string, e: InboxEntry): void {
  const p = inboxPath(piDir, seat);
  try {
    mkdirSync(join(piDir, "a2a_inbox"), { recursive: true });
    appendFileSync(p, JSON.stringify(e) + "\n");
  } catch {
    /* inbox is best-effort observability — never fail the task on it */
  }
}

/** Newest-first entries. Corrupt lines are skipped. */
export function readInbox(
  piDir: string,
  seat: string,
  opts: { limit?: number; taskId?: string; sinceTs?: string } = {},
): InboxEntry[] {
  const p = inboxPath(piDir, seat);
  if (!existsSync(p)) return [];
  let raw: string;
  try {
    raw = readFileSync(p, "utf-8");
  } catch {
    return [];
  }
  if (raw.length > MAX_READ_BYTES) raw = raw.slice(raw.length - MAX_READ_BYTES);
  const out: InboxEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as InboxEntry;
      if (!e || typeof e.taskId !== "string") continue;
      if (opts.taskId && e.taskId !== opts.taskId) continue;
      if (opts.sinceTs && !(e.ts > opts.sinceTs)) continue;
      out.push(e);
    } catch {
      /* skip torn/corrupt line */
    }
  }
  out.reverse();
  return opts.limit ? out.slice(0, opts.limit) : out;
}

/** Strip control characters and cap peer-controlled display strings. */
function safe(s: string, max = 40): string {
  // eslint-disable-next-line no-control-regex
  const clean = String(s ?? "").replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim();
  return clean.length > max ? clean.slice(0, max - 1) + "…" : clean;
}

function shortState(state: string): string {
  return state.replace("TASK_STATE_", "").toLowerCase();
}

/**
 * One bounded, metadata-only digest for the host model. Empty string when
 * there is nothing unread. `entries` newest-first.
 */
export function digestUnread(entries: InboxEntry[], opts: { max: number }): string {
  if (entries.length === 0) return "";
  const lines = [
    `[a2a-inbox] ${entries.length} inbound a2a task(s) reached a terminal state since your last turn ` +
      `(handled in detached child sessions — do not redo them). Details: a2a_inbox(task_id).`,
  ];
  for (const e of entries.slice(0, opts.max)) {
    const secs = (e.elapsedMs / 1000).toFixed(0);
    const tail = e.state === "TASK_STATE_FAILED" && e.error ? ` — ${safe(e.error, 80)}` : "";
    const flag = e.needsPrincipal ? " · ⚑ needs principal" : "";
    lines.push(`- ${e.taskId} from ${safe(e.identity)} · ${shortState(e.state)} · ${secs}s${flag}${tail}`);
  }
  if (entries.length > opts.max) lines.push(`  … and ${entries.length - opts.max} more (a2a_inbox() lists them)`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Wake coalescer (#27 E): "idle → deliver now, busy → wait" is the host's
// job (sendMessage followUp + triggerTurn); ours is to make sure a burst of
// needs_principal outcomes wakes the principal ONCE per merge window
// (leading edge + one trailing flush), so a 5-minute window costs at most one
// prompt-cache miss.
// ---------------------------------------------------------------------------

export class WakeCoalescer {
  private pending: InboxEntry[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private windowOpen = false;

  constructor(
    private readonly windowMs: number,
    private readonly send: (entries: InboxEntry[]) => void,
  ) {}

  /** Queue an entry. Fires immediately when no window is open; otherwise the
   *  entry rides the trailing flush at window end. */
  push(e: InboxEntry): void {
    this.pending.push(e);
    if (!this.windowOpen) {
      this.flush();
      this.windowOpen = true;
      this.timer = setTimeout(() => this.onWindowEnd(), this.windowMs);
      this.timer.unref?.();
    }
  }

  private onWindowEnd(): void {
    this.timer = null;
    if (this.pending.length > 0) {
      // Trailing flush opens a fresh window so a steady stream stays at one
      // wake per window.
      this.flush();
      this.timer = setTimeout(() => this.onWindowEnd(), this.windowMs);
      this.timer.unref?.();
    } else {
      this.windowOpen = false;
    }
  }

  private flush(): void {
    const batch = this.pending;
    this.pending = [];
    try {
      this.send(batch);
    } catch {
      /* wake is best-effort */
    }
  }

  /** Test/shutdown hook. */
  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pending = [];
    this.windowOpen = false;
  }
}
