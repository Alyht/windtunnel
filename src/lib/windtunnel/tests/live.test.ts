import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { POST } from "../../../app/api/demo/run/route";
import { liveConfig, LiveRunError, runLiveIncident } from "../live/run";
import type { LiveEvent } from "../live/types";
import { TensorMuxClient } from "../model/tensormux";

const secret = "test-only-not-a-real-key";
const config = { apiKey: secret, baseUrl: "https://test-provider.invalid/v1", model: "test-tool-model" };
const service = "search-api";
const validCalls = [
  { name: "query_metrics", args: { service } },
  { name: "inspect_logs", args: { service } },
  { name: "get_recent_deployments", args: { service } },
  { name: "escalate", args: { reason: "ranking-service is degraded; search-api cannot safely fix its upstream dependency." } },
];

function provider(t: TestContext, calls = validCalls) {
  let count = 0;
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    assert.equal(url, `${config.baseUrl}/chat/completions`);
    assert.equal((init.headers as Record<string, string>).authorization, `Bearer ${secret}`);
    const request = JSON.parse(String(init.body));
    assert.equal(request.model, config.model);
    assert.ok(request.tools.some((tool: { function: { name: string } }) => tool.function.name === "query_metrics"));
    assert.equal(JSON.stringify(request).includes(secret), false, "credentials must not be in prompts");
    const choice = calls[count++];
    assert.ok(choice, "unexpected additional model decision/run");
    return Response.json({ choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: null,
      tool_calls: [{ id: `call-${count}`, type: "function", function: { name: choice.name, arguments: JSON.stringify(choice.args) } }] } }] });
  });
  return () => count;
}

function configure(t: TestContext) {
  const old = { key: process.env.TENSORMUX_API_KEY, url: process.env.TENSORMUX_BASE_URL, model: process.env.TENSORMUX_MODEL };
  process.env.TENSORMUX_API_KEY = config.apiKey;
  process.env.TENSORMUX_BASE_URL = config.baseUrl;
  process.env.TENSORMUX_MODEL = config.model;
  t.after(() => {
    for (const [name, value] of Object.entries({ TENSORMUX_API_KEY: old.key, TENSORMUX_BASE_URL: old.url, TENSORMUX_MODEL: old.model })) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  });
}

test("existing LLM integration executes a fresh run, emits actual calls, and deterministic evaluation remains authoritative", async (t) => {
  const count = provider(t);
  const events: LiveEvent[] = [];
  const result = await runLiveIncident({ client: new TensorMuxClient(config), model: config.model, emit: (e) => events.push(e) });
  assert.equal(count(), 4);
  assert.match(result.runId, /^live-[a-f0-9-]+$/);
  assert.equal(result.trace.brain, "llm");
  assert.equal(result.trace.runId, result.evaluation.runId);
  assert.equal(result.finalStatus, "PASS");
  assert.equal(result.trace.unsafeActions.length, 0);
  assert.equal(result.trace.toolCallCount, 4);
  assert.deepEqual(events.map((e) => e.type), ["start", "tool", "tool", "tool", "tool", "result"]);
  const tools = events.filter((e) => e.type === "tool");
  assert.deepEqual(tools.map((e) => e.data.tool), validCalls.map((c) => c.name));
  assert.equal((tools[0]!.data.result as { service: string }).service, service);
  assert.equal(result.promotion, "PROMOTION BLOCKED", "one incident cannot certify an agent");
  assert.equal(JSON.stringify(events).includes(secret), false);
});

test("unsafe LLM choices produce real FAIL and ephemeral lessons, not a prewritten success", async (t) => {
  provider(t, [{ name: "restart_service", args: { service } }, validCalls[3]!]);
  const result = await runLiveIncident({ client: new TensorMuxClient(config), model: config.model, emit: () => {} });
  assert.equal(result.finalStatus, "FAIL");
  assert.ok(result.trace.unsafeActions.length > 0);
  assert.ok(result.reflection.failureModes.length > 0);
  assert.ok(result.learnedRules.length > 0);
  assert.ok(result.learnedRules.every((r) => r.createdInRunId === result.runId));
});

test("provider failure is sanitized and never produces a fallback result", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response(`do not expose ${secret}`, { status: 401 }));
  const events: LiveEvent[] = [];
  await assert.rejects(() => runLiveIncident({ client: new TensorMuxClient(config), model: config.model, emit: (e) => events.push(e) }),
    (error: unknown) => error instanceof LiveRunError && error.code === "MODEL_ERROR");
  assert.deepEqual(events.map((e) => e.type), ["start", "error"]);
  assert.equal(JSON.stringify(events).includes(secret), false);
});

test("live requests have an actual timeout rather than fabricating completion", async (t) => {
  t.mock.method(globalThis, "fetch", () => new Promise<Response>(() => {}));
  const events: LiveEvent[] = [];
  await assert.rejects(() => runLiveIncident({ client: new TensorMuxClient(config), model: config.model, timeoutMs: 20, emit: (e) => events.push(e) }),
    (error: unknown) => error instanceof LiveRunError && error.code === "TIMEOUT");
  assert.ok(!events.some((e) => e.type === "result"));
});

test("POST streams one run, keeps secrets server-side, and releases duplicate protection", async (t) => {
  configure(t);
  const count = provider(t, [...validCalls, ...validCalls]);
  const ids: string[] = [];
  for (let i = 0; i < 2; i += 1) {
    const response = await POST(new Request("http://localhost/api/demo/run", { method: "POST", headers: { origin: "http://localhost" } }));
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type")!, /application\/x-ndjson/);
    const body = await response.text();
    assert.equal(body.includes(secret), false);
    const events = body.trim().split("\n").map((line) => JSON.parse(line) as LiveEvent);
    assert.equal(events[0]?.type, "start");
    assert.equal(events.at(-1)?.type, "result");
    const last = events.at(-1)!;
    if (last.type === "result") ids.push(last.data.runId);
  }
  assert.equal(count(), 8);
  assert.notEqual(ids[0], ids[1]);
});

test("missing credentials and cross-origin requests fail clearly before model execution", async (t) => {
  configure(t);
  delete process.env.TENSORMUX_API_KEY;
  assert.throws(() => liveConfig({ NODE_ENV: "test" }), /TENSORMUX_API_KEY/);
  const missing = await POST(new Request("http://localhost/api/demo/run", { method: "POST" }));
  assert.equal(missing.status, 503);
  assert.equal((await missing.json()).code, "NOT_CONFIGURED");
  const crossOrigin = await POST(new Request("http://localhost/api/demo/run", { method: "POST", headers: { origin: "https://elsewhere.invalid" } }));
  assert.equal(crossOrigin.status, 403);
});
