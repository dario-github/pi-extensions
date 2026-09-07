import { assert } from "chai";

import { makeTempDir } from "./tmp";
import { appendInbox } from "../lib/inbox";

/**
 * Host-level wiring for #27: load the extension against a mock ExtensionAPI in
 * an isolated PI_CODING_AGENT_DIR and drive the before_agent_start hook and
 * the a2a_inbox tool directly.
 */
describe("index wiring — inbound inbox (#27)", () => {
  let savedDir: string | undefined;
  let savedName: string | undefined;
  let agentDir: string;
  let cwd: string;

  beforeEach(() => {
    savedDir = process.env.PI_CODING_AGENT_DIR;
    savedName = process.env.A2A_AGENT_NAME;
    agentDir = makeTempDir("pi-a2a-idx-agent-");
    cwd = makeTempDir("pi-a2a-idx-cwd-");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.A2A_AGENT_NAME = "seatx-3"; // suffix must be stripped for the inbox seat key
  });
  afterEach(() => {
    if (savedDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = savedDir;
    if (savedName === undefined) delete process.env.A2A_AGENT_NAME;
    else process.env.A2A_AGENT_NAME = savedName;
  });

  async function loadExt(): Promise<{ handlers: Map<string, any[]>; tools: Map<string, any> }> {
    const handlers = new Map<string, any[]>();
    const tools = new Map<string, any>();
    const pi: any = {
      registerTool: (t: any) => tools.set(t.name, t),
      registerEntryRenderer: () => {},
      registerMessageRenderer: () => {},
      registerCommand: () => {},
      on: (ev: string, fn: any) => handlers.set(ev, [...(handlers.get(ev) ?? []), fn]),
      appendEntry: () => {},
      sendMessage: () => {},
    };
    // Fresh module instance per test (module-level cursor/state).
    const mod = await import(`../index.ts?t=${Date.now()}-${Math.random()}`);
    await mod.default(pi);
    return { handlers, tools };
  }

  it("before_agent_start injects one bounded digest for unread terminal entries, then advances the cursor", async () => {
    const { handlers } = await loadExt();
    const hook = handlers.get("before_agent_start")?.[0];
    assert.isFunction(hook, "extension registers before_agent_start");
    const ctx: any = { cwd };
    // Nothing unread yet → no injection.
    assert.isUndefined(await hook({ prompt: "hi" }, ctx));
    // Two terminal entries land in the SEAT inbox (suffix stripped: seatx-3 → seatx).
    const later = new Date(Date.now() + 1000).toISOString();
    appendInbox(agentDir, "seatx", { ts: later, taskId: "task-a", contextId: "c1", identity: "foreman", state: "TASK_STATE_COMPLETED", elapsedMs: 4200 });
    appendInbox(agentDir, "seatx", { ts: later, taskId: "task-b", contextId: "c2", identity: "ceo", state: "TASK_STATE_FAILED", elapsedMs: 900, error: "boom" });
    const r = await hook({ prompt: "what happened?" }, ctx);
    assert.exists(r?.message, "digest injected at the turn boundary");
    assert.equal(r.message.customType, "a2a-inbox");
    assert.include(r.message.content, "2 inbound a2a task(s)");
    assert.include(r.message.content, "task-a from foreman");
    assert.include(r.message.content, "boom");
    // Cursor advanced: same entries are not re-injected next turn.
    assert.isUndefined(await hook({ prompt: "again" }, ctx));
  });

  it("a2a_inbox lists entries and reads one with its transcript pointer", async () => {
    const { tools } = await loadExt();
    const tool = tools.get("a2a_inbox");
    assert.exists(tool, "a2a_inbox registered");
    const ctx: any = { cwd };
    appendInbox(agentDir, "seatx", { ts: new Date().toISOString(), taskId: "task-z", contextId: "cz", identity: "harness", state: "TASK_STATE_COMPLETED", elapsedMs: 61000, sessionFile: "/tmp/x/child.jsonl" });
    const list = await tool.execute("1", {}, undefined, undefined, ctx);
    const listText = list.content[0].text as string;
    assert.include(listText, "seat seatx");
    assert.include(listText, "task-z · from harness · completed · 61s");
    const one = await tool.execute("2", { task_id: "task-z" }, undefined, undefined, ctx);
    const oneText = one.content[0].text as string;
    assert.include(oneText, "context: cz");
    assert.include(oneText, "/tmp/x/child.jsonl", "points at the child transcript when the reply is not in-process");
    const none = await tool.execute("3", { task_id: "task-nope" }, undefined, undefined, ctx);
    assert.include(none.content[0].text, "No inbound task");
  });
});
