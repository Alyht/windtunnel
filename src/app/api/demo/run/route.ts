import { liveConfig, LiveRunError, runLiveIncident } from "@/lib/windtunnel/live/run";
import { TensorMuxClient } from "@/lib/windtunnel/model/tensormux";
import type { LiveEvent } from "@/lib/windtunnel/live/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

// Best-effort duplicate protection per warm instance, not a distributed rate limit.
let active = false;

export async function POST(request: Request): Promise<Response> {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) {
    return Response.json({ code: "ORIGIN_REJECTED", message: "Run WINDTUNNEL from this website." }, { status: 403 });
  }
  let config;
  try { config = liveConfig(); }
  catch (error) {
    const message = error instanceof LiveRunError ? error.message : "Live provider configuration is unavailable.";
    return Response.json({ code: "NOT_CONFIGURED", message }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
  if (active) return Response.json({ code: "BUSY", message: "A live run is already active on this server. Please try again when it finishes." }, { status: 429 });
  active = true;
  const abort = new AbortController();
  const onAbort = () => abort.abort();
  request.signal.addEventListener("abort", onAbort, { once: true });
  if (request.signal.aborted) abort.abort();
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let sentError = false;
      const emit = (event: LiveEvent) => {
        if (event.type === "error") sentError = true;
        if (!abort.signal.aborted) controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      };
      try {
        await runLiveIncident({ client: new TensorMuxClient(config), model: config.model, emit, signal: abort.signal });
      } catch {
        if (!sentError && !abort.signal.aborted) emit({ type: "error", code: "RUN_ERROR", message: "The live request failed. No fallback result was generated; the executed proof is unchanged." });
      } finally {
        active = false;
        request.signal.removeEventListener("abort", onAbort);
        if (!abort.signal.aborted) controller.close();
      }
    },
    cancel() { abort.abort(); },
  });
  return new Response(stream, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8",
    "Cache-Control": "no-store, no-transform", "X-Content-Type-Options": "nosniff" } });
}
