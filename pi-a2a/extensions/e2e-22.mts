/**
 * Isolated loopback E2E for #22 — two real peers on 127.0.0.1, temp piDirs,
 * no shared settings, no live workstations. Proves:
 *   1. blocking:false returns promptly with a WORKING handle even when the
 *      task duration (5s) exceeds replyTimeoutSec (2s);
 *   2. tasks/get transitions WORKING → COMPLETED with the reply artifact;
 *   3. a blocking call with the same slow runner dies FAILED at replyTimeout;
 *   4. foreign identity cannot poll another peer's task (#10);
 *   5. tasks/cancel on a background task stays CANCELED;
 *   6. a stubborn runner resolving after the timeout abort is FAILED, with
 *      no partial artifact (blocking path regression).
 */
import { A2AServer, type SessionRunner } from "./lib/server";
import { a2aSend, a2aTask, a2aCall } from "./lib/client";
import { DEFAULTS } from "./test/helpers";
import { makeTempDir } from "./test/tmp";
import type { A2AConfig } from "./lib/config";

const results: string[] = [];
function check(name: string, ok: boolean, detail = ""): void {
  results.push(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) process.exitCode = 1;
}

function serverCfg(): A2AConfig {
  const cfg = DEFAULTS();
  cfg.server.replyTimeoutSec = 2;
  cfg.server.taskTimeoutSec = 60;
  cfg.server.peerTokens = { alice: "tok-alice", bob: "tok-bob" };
  cfg.discovery.local.enabled = false; // no registry writes — fully isolated
  return cfg;
}

function clientCfg(url: string): A2AConfig {
  const cfg = DEFAULTS();
  cfg.peers.worker = { url, auth: { type: "bearer", token: "tok-alice" }, timeout: 8000, capabilities: [] };
  cfg.peers.workerAsBob = { url, auth: { type: "bearer", token: "tok-bob" }, timeout: 8000, capabilities: [] };
  cfg.discovery.local.enabled = false;
  return cfg;
}

const SLOW_MS = 5000;
const slowRunner: SessionRunner = async ({ signal }) => {
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, SLOW_MS);
    signal.addEventListener("abort", () => { clearTimeout(t); reject(new Error("aborted")); }, { once: true });
  });
  return { reply: "slow task finished", inputRequired: false };
};
const stubbornRunner: SessionRunner = ({ signal }) =>
  new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve({ reply: "partial mid-work draft", inputRequired: false }), { once: true });
  });

// --- peer with the slow runner --------------------------------------------
const serverPiDir = makeTempDir("e2e22-srv-");
const server = new A2AServer({ cfg: serverCfg(), cwd: makeTempDir("e2e22-cwd-"), piDir: serverPiDir, runner: slowRunner });
const info = await server.start();
const cfg = clientCfg(info.url);
const clientPiDir = makeTempDir("e2e22-cli-");

// 1+2: non-blocking dispatch survives replyTimeoutSec
const t0 = Date.now();
const submitted = await a2aSend({ cfg, piDir: clientPiDir, agent: "worker", message: "run the 5s job" });
const submitMs = Date.now() - t0;
check("a2a_send returns promptly", submitMs < 1500, `${submitMs}ms (replyTimeoutSec=2, task=${SLOW_MS}ms)`);
check("a2a_send returns WORKING handle", submitted.includes("working") && /task-[0-9a-f]+/.test(submitted), submitted.split("\n")[0]);
const taskId = submitted.match(/task-[0-9a-f]+/)![0]!;

const early = await a2aTask({ cfg, piDir: clientPiDir, agent: "worker", taskId });
check("tasks/get right after submit is WORKING", early.includes("working") && early.includes("Still running"), early.split("\n")[0]);

// 4: foreign identity cannot poll
const foreign = await a2aTask({ cfg, piDir: clientPiDir, agent: "workerAsBob", taskId });
check("foreign identity rejected", foreign.includes("not found"), foreign.split("\n")[0]);

// wait for completion, then poll
await new Promise((r) => setTimeout(r, SLOW_MS + 800));
const done = await a2aTask({ cfg, piDir: clientPiDir, agent: "worker", taskId });
check("tasks/get after completion is COMPLETED + artifact", done.includes("completed") && done.includes("slow task finished"), done.split("\n")[0]);

// 3: same runner on the blocking path dies at replyTimeoutSec
const blocking = await a2aCall({ cfg, piDir: clientPiDir, agent: "worker", message: "same job, blocking" });
check("blocking call fails at reply timeout", blocking.toLowerCase().includes("failed"), blocking.split("\n")[0]);

// 5: cancel a background task → CANCELED
const submitted2 = await a2aSend({ cfg, piDir: clientPiDir, agent: "worker", message: "cancel me" });
const taskId2 = submitted2.match(/task-[0-9a-f]+/)![0]!;
await new Promise((r) => setTimeout(r, 300));
const cancelResp = await fetch(info.url, {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: "Bearer tok-alice" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tasks/cancel", params: { id: taskId2 } }),
}).then((r) => r.json());
check("tasks/cancel returns CANCELED", cancelResp.result?.status?.state === "TASK_STATE_CANCELED");
const canceled = await a2aTask({ cfg, piDir: clientPiDir, agent: "worker", taskId: taskId2 });
check("polled state stays CANCELED (not failed)", canceled.includes("canceled"), canceled.split("\n")[0]);

await server.stop();

// --- peer with the stubborn runner (late resolve after timeout abort) ------
const stubborn = new A2AServer({ cfg: serverCfg(), cwd: makeTempDir("e2e22-cwd-"), piDir: makeTempDir("e2e22-srv-"), runner: stubbornRunner });
const info2 = await stubborn.start();
const cfg2 = clientCfg(info2.url);
const r = await a2aCall({ cfg: cfg2, piDir: clientPiDir, agent: "worker", message: "stubborn" });
check("late resolve after timeout abort is FAILED", r.toLowerCase().includes("failed"), r.split("\n")[0]);
check("no partial artifact leaked", !r.includes("partial mid-work draft"));
await stubborn.stop();

console.log("\n=== E2E #22 results ===");
for (const line of results) console.log(line);
