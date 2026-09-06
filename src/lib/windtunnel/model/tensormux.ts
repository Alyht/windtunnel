/**
 * Minimal OpenAI-compatible chat-completions client for TensorMux.
 *
 * Deliberately dependency-free: it is a `fetch` call and a couple of types.
 * Configuration comes from TENSORMUX_API_KEY / TENSORMUX_BASE_URL /
 * TENSORMUX_MODEL (see .env.example).
 */

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCallMessage[];
  tool_call_id?: string;
}

export interface ToolCallMessage {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ChatCompletionRequest {
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  temperature?: number;
}

export interface ChatCompletionChoice {
  message: ChatMessage;
  finish_reason: string;
}

export interface TensorMuxConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
}

export class TensorMuxError extends Error {}

export function readTensorMuxConfig(env: NodeJS.ProcessEnv = process.env): TensorMuxConfig | null {
  const apiKey = env.TENSORMUX_API_KEY?.trim();
  if (!apiKey) return null;
  return {
    apiKey,
    baseUrl: (env.TENSORMUX_BASE_URL?.trim() || "https://api.tensormux.com/v1").replace(/\/$/, ""),
    model: env.TENSORMUX_MODEL?.trim() || "glm-4-7-flash",
  };
}

export class TensorMuxClient {
  constructor(private readonly config: TensorMuxConfig) {}

  async chat(request: ChatCompletionRequest): Promise<ChatCompletionChoice> {
    const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify({
        model: this.config.model,
        messages: request.messages,
        ...(request.tools ? { tools: request.tools, tool_choice: "auto" } : {}),
        // Determinism matters more than creativity for incident response.
        temperature: request.temperature ?? 0,
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new TensorMuxError(
        `TensorMux request failed with ${response.status} ${response.statusText}: ${body.slice(0, 400)}`,
      );
    }

    const payload = (await response.json()) as { choices?: ChatCompletionChoice[] };
    const choice = payload.choices?.[0];
    if (!choice) {
      throw new TensorMuxError("TensorMux response contained no choices");
    }
    return choice;
  }
}
