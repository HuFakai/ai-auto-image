import { describe, expect, it } from "vitest";
import { WorkflowExecutor, type NodeRunPort, type RunStatusPort, type NodeRunRecord } from "./index";
import { AiError } from "@aai/ai-core";

const runs = new Map<string, NodeRunRecord>();
const nodeRuns: NodeRunPort = {
  async upsert(record) {
    runs.set(record.nodeKey, record);
  },
  async listByRun() {
    return [...runs.values()];
  },
  async get(_runId, nodeKey) {
    return runs.get(nodeKey);
  },
};
const runStatus: RunStatusPort = {
  async setStatus() {},
};

describe("workflow executor", () => {
  it("retries retryable failures and keeps going", async () => {
    let failOnce = true;
    const exec = new WorkflowExecutor({
      nodeRuns,
      runStatus,
      handlers: {
        flaky: () => {
          if (failOnce) {
            failOnce = false;
            return Promise.reject(new AiError("upstream", "transient"));
          }
          return Promise.resolve("ok");
        },
        next: () => Promise.resolve("done"),
      },
    });
    const result = await exec.run({
      runId: "r1",
      projectId: "p1",
      nodes: [
        { key: "a", kind: "flaky" },
        { key: "b", kind: "next" },
      ],
    });
    expect(result.status).toBe("REVIEWING");
    expect(runs.get("a")?.attempt).toBe(2);
    expect(runs.get("b")?.status).toBe("SUCCEEDED");
  });

  it("marks node final after max attempts", async () => {
    runs.clear();
    const exec = new WorkflowExecutor({
      nodeRuns,
      runStatus,
      handlers: {
        always_fails: () => Promise.reject(new AiError("upstream", "permanent-ish")),
      },
      maxAttemptsPerNode: 2,
    });
    const result = await exec.run({ runId: "r2", projectId: "p1", nodes: [{ key: "a", kind: "always_fails" }] });
    expect(result.status).toBe("FAILED_RETRYABLE");
    expect(runs.get("a")?.attempt).toBe(2);
  });

  it("skips already-succeeded nodes on resume", async () => {
    runs.clear();
    runs.set("a", {
      id: "r3:a",
      runId: "r3",
      nodeKey: "a",
      kind: "done_kind",
      status: "SUCCEEDED",
      attempt: 1,
      outputRef: JSON.stringify({ cached: true }),
    });
    let called = 0;
    const exec = new WorkflowExecutor({
      nodeRuns,
      runStatus,
      handlers: {
        done_kind: () => {
          called += 1;
          return Promise.resolve("x");
        },
        b: () => Promise.resolve("y"),
      },
    });
    const result = await exec.run({
      runId: "r3",
      projectId: "p1",
      nodes: [
        { key: "a", kind: "done_kind" },
        { key: "b", kind: "b" },
      ],
    });
    expect(result.status).toBe("REVIEWING");
    expect(called).toBe(0);
  });
});
