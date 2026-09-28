// Offline routing matrix for opencode-go models.
//
// Drives the REAL handleChatCore guard + targetFormat resolution (open-sse/handlers/chatCore.js:86-94)
// end-to-end; only the executor's HTTP response is mocked. The assertion target is
// credentials.runtimeTransport — the exact field DefaultExecutor.buildUrl/buildHeaders read
// (open-sse/executors/default.js:106,150) to pick the endpoint and auth scheme — so a wrong
// guard decision shows up as the wrong baseUrl here, same as it would on the wire.
//
// Cells:
//   - deepseek × {openai, claude, openai-responses} × {bare, (max)} — the endpoint matrix
//     under dispute in #3278/#3332. Bare and suffixed cells must resolve identically.
//   - glm/kimi (chat-only) + (max) — regression cells: with the thinking suffix, the guard
//     is bypassed on master (suffix isn't stripped before the registry lookup) and these get
//     routed to /messages, which the upstream does not serve for them.
//   - minimax + (max) + claude — suffix must NOT block a genuinely declared format.
//   - wire-shape cells: assert the body handed to the executor (post prepareClaudeRequest)
//     carries the unsigned thinking placeholder on the /messages passthrough — the offline
//     stand-in for the #4436 live replay until one runs on a real go-lane account.
import { describe, it, expect, vi, beforeEach } from "vitest";

const { executeMock } = vi.hoisted(() => ({
  executeMock: vi.fn(),
}));

vi.mock("../../open-sse/executors/index.js", () => ({
  getExecutor: () => ({
    noAuth: true,
    execute: executeMock,
  }),
}));

vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: async () => ({
    logClientRawRequest: vi.fn(),
    logRawRequest: vi.fn(),
    logTargetRequest: vi.fn(),
    logProviderResponse: vi.fn(),
    logConvertedResponse: vi.fn(),
    logError: vi.fn(),
  }),
}));

vi.mock("../../open-sse/utils/stream.js", () => ({
  COLORS: { red: "", reset: "" },
  createPassthroughStreamWithLogger: vi.fn(() => new TransformStream()),
}));

vi.mock("uuid", () => ({
  v4: () => "00000000-0000-4000-8000-000000000000",
}));

vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {}),
}));

// image.js imports Agent from "undici" (not installed in some dev envs); the
// prefetch path is irrelevant to routing assertions.
vi.mock("../../open-sse/translator/concerns/image.js", () => ({
  encodeDataUri: (mimeType, base64) => `data:${mimeType};base64,${base64}`,
  parseDataUri: (url) => {
    const m = /^data:([^;]+);base64,(.*)$/.exec(url);
    return m ? { mimeType: m[1], base64: m[2] } : null;
  },
  fetchImageAsBase64: async () => null,
}));

const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");

const BASE = "https://opencode.ai/zen/go/v1";
const ENDPOINTS = {
  openai: `${BASE}/chat/completions`,
  claude: `${BASE}/messages`,
  "openai-responses": `${BASE}/responses`,
};

// Minimal non-stream provider JSON per target format — the mocked executor's response.
const RESPONSE_BY_FORMAT = {
  claude: {
    id: "msg_1", type: "message", role: "assistant", model: "test",
    content: [{ type: "text", text: "ok" }],
    stop_reason: "end_turn", stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  },
  openai: {
    id: "chatcmpl-1", object: "chat.completion", model: "test",
    choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  },
  "openai-responses": {
    id: "resp_1", object: "response", created_at: 0, status: "completed", model: "test",
    output: [{
      type: "message", id: "msg_1", role: "assistant", status: "completed",
      content: [{ type: "output_text", text: "ok", annotations: [] }],
    }],
  },
};

async function route(model, sourceFormat) {
  executeMock.mockResolvedValueOnce({
    response: new Response(JSON.stringify(RESPONSE_BY_FORMAT[sourceFormat === "openai" ? "openai" : sourceFormat] || RESPONSE_BY_FORMAT.openai), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
    url: ENDPOINTS[sourceFormat] || ENDPOINTS.openai,
    headers: {},
    transformedBody: null,
  });

  const credentials = { apiKey: "test-key", providerSpecificData: {} };
  const result = await handleChatCore({
    body: {
      model: `opencode-go/${model}`,
      stream: false,
      max_tokens: 16,
      messages: [{ role: "user", content: "hi" }],
    },
    modelInfo: { provider: "opencode-go", model },
    credentials,
    connectionId: "ocg-route-test",
    sourceFormatOverride: sourceFormat,
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
  });

  const { credentials: creds } = executeMock.mock.calls.at(-1)[0];
  return { result, runtimeTransport: creds.runtimeTransport ?? null };
}

describe("opencode-go DeepSeek endpoint matrix (via real handleChatCore)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  for (const model of ["deepseek-v4-flash", "deepseek-v4-pro"]) {
    for (const suffix of ["", "(max)"]) {
      const id = model + suffix;
      for (const [fmt, expectedUrl] of Object.entries(ENDPOINTS)) {
        it(`routes ${id} + ${fmt}-format client to ${expectedUrl}`, async () => {
          const { result, runtimeTransport } = await route(id, fmt);
          expect(result.success).toBe(true);
          expect(runtimeTransport?.baseUrl).toBe(expectedUrl);
        });
      }
    }
  }
});

describe("opencode-go thinking-suffix guard (regression)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does NOT route chat-only glm-5.2(max) to /messages on a claude-format request", async () => {
    const { result, runtimeTransport } = await route("glm-5.2(max)", "claude");
    expect(result.success).toBe(true);
    expect(runtimeTransport).toBeNull(); // guard must block; falls back to chat/completions
  });

  it("does NOT route chat-only kimi-k2.6(max) to /responses on a responses-format request", async () => {
    const { result, runtimeTransport } = await route("kimi-k2.6(max)", "openai-responses");
    expect(result.success).toBe(true);
    expect(runtimeTransport).toBeNull();
  });

  it("still routes minimax-m3(max) + claude-format client to /messages", async () => {
    const { result, runtimeTransport } = await route("minimax-m3(max)", "claude");
    expect(result.success).toBe(true);
    expect(runtimeTransport?.baseUrl).toBe(ENDPOINTS.claude);
  });

  it("does NOT route minimax-m3(max) (no responses support) to /responses", async () => {
    const { result, runtimeTransport } = await route("minimax-m3(max)", "openai-responses");
    expect(result.success).toBe(true);
    expect(runtimeTransport).toBeNull();
  });
});
// Wire-shape cells for the #4436 thinking injection: the body captured at executor.execute
// is the translatedBody that prepareClaudeRequest produced — the last translation-layer
// artifact before dispatch, i.e. what a live /messages replay would put on the wire.
async function runClaude(body, model) {
  executeMock.mockResolvedValueOnce({
    response: new Response(JSON.stringify(RESPONSE_BY_FORMAT.claude), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
    url: ENDPOINTS.claude,
    headers: {},
    transformedBody: null,
  });

  const result = await handleChatCore({
    body: { ...body, model: `opencode-go/${model}`, stream: false },
    modelInfo: { provider: "opencode-go", model },
    credentials: { apiKey: "test-key", providerSpecificData: {} },
    connectionId: "ocg-inject-test",
    sourceFormatOverride: "claude",
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
  });

  const call = executeMock.mock.calls.at(-1)[0];
  return { result, wireBody: call.body, runtimeTransport: call.credentials.runtimeTransport ?? null };
}

const THINKING_TOOL_LOOP = {
  max_tokens: 2048,
  thinking: { type: "enabled", budget_tokens: 1024 },
  messages: [
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "toolu_1", name: "get_weather", input: { city: "Paris" } }],
    },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "18C" }] },
  ],
};

function assistantBlocks(wireBody) {
  const assistant = wireBody.messages.find((m) => m.role === "assistant");
  return assistant?.content ?? [];
}

describe("opencode-go DeepSeek thinking injection wire shape (via real handleChatCore)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("puts an unsigned thinking placeholder on the /messages wire body for deepseek-v4-flash(max)", async () => {
    const { result, wireBody, runtimeTransport } = await runClaude(THINKING_TOOL_LOOP, "deepseek-v4-flash(max)");
    expect(result.success).toBe(true);
    expect(runtimeTransport?.baseUrl).toBe(ENDPOINTS.claude); // claude passthrough, no translation detour

    const blocks = assistantBlocks(wireBody);
    expect(blocks[0]).toEqual({ type: "thinking", thinking: "." }); // unsigned: no signature key
    expect(blocks.filter((b) => b.type === "tool_use")).toHaveLength(1);
  });

  it("injects nothing for minimax-m3 on the same /messages passthrough", async () => {
    const { result, wireBody, runtimeTransport } = await runClaude(THINKING_TOOL_LOOP, "minimax-m3");
    expect(result.success).toBe(true);
    expect(runtimeTransport?.baseUrl).toBe(ENDPOINTS.claude);

    const blocks = assistantBlocks(wireBody);
    expect(blocks).toHaveLength(1); // tool_use only — no placeholder
    expect(blocks[0].type).toBe("tool_use");
  });
});
