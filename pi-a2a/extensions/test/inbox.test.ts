import { assert } from "chai";
import { readFileSync, existsSync, appendFileSync } from "node:fs";

import { makeTempDir } from "./tmp";
import { appendInbox, readInbox, digestUnread, inboxPath, type InboxEntry } from "../lib/inbox";

function entry(i: number, over: Partial<InboxEntry> = {}): InboxEntry {
  return {
    ts: `2026-09-07T00:00:0${i}.000Z`,
    taskId: `task-${i}`,
    contextId: `ctx-${i}`,
    identity: "peer-a",
    state: "TASK_STATE_COMPLETED",
    elapsedMs: 1000 * i,
    ...over,
  };
}

describe("inbox (#27 inbound visibility)", () => {
  it("appends one JSON line per terminal event, keyed by seat", () => {
    const piDir = makeTempDir("pi-a2a-inbox-");
    appendInbox(piDir, "mesh", entry(1));
    appendInbox(piDir, "mesh", entry(2, { state: "TASK_STATE_FAILED", error: "boom" }));
    const p = inboxPath(piDir, "mesh");
    assert.isTrue(existsSync(p));
    const lines = readFileSync(p, "utf-8").trim().split("\n");
    assert.lengthOf(lines, 2);
    assert.equal(JSON.parse(lines[1]!).error, "boom");
  });

  it("readInbox returns newest-first, bounded by limit, and can filter by taskId", () => {
    const piDir = makeTempDir("pi-a2a-inbox-");
    for (let i = 1; i <= 7; i++) appendInbox(piDir, "mesh", entry(i));
    const latest = readInbox(piDir, "mesh", { limit: 3 });
    assert.deepEqual(latest.map((e) => e.taskId), ["task-7", "task-6", "task-5"]);
    const one = readInbox(piDir, "mesh", { taskId: "task-4" });
    assert.lengthOf(one, 1);
    assert.equal(one[0]!.contextId, "ctx-4");
  });

  it("readInbox tolerates a missing file and a corrupt line", () => {
    const piDir = makeTempDir("pi-a2a-inbox-");
    assert.deepEqual(readInbox(piDir, "nobody"), []);
    appendInbox(piDir, "mesh", entry(1));
    const p = inboxPath(piDir, "mesh");
    appendFileSync(p, "{not json\n");
    appendInbox(piDir, "mesh", entry(2));
    assert.lengthOf(readInbox(piDir, "mesh"), 2);
  });

  it("digestUnread is metadata-only, capped, and sanitizes peer-controlled strings", () => {
    const entries: InboxEntry[] = [];
    for (let i = 1; i <= 8; i++) entries.push(entry(i, { identity: i === 8 ? "evil\u001b[31m\npeer\u0007" : "peer-a" }));
    entries.reverse(); // readInbox contract: newest-first
    const d = digestUnread(entries, { max: 5 });
    assert.include(d, "8 inbound a2a task(s)");
    assert.notInclude(d, "\u001b", "control chars stripped");
    assert.notInclude(d, "\u0007");
    assert.equal(d.split("\n").filter((l) => l.trim().startsWith("-")).length, 5, "at most 5 lines listed");
    assert.include(d, "a2a_inbox", "digest points at the pull tool");
    assert.include(d, "task-8");
  });

  it("digestUnread returns empty for no entries", () => {
    assert.equal(digestUnread([], { max: 5 }), "");
  });
});
