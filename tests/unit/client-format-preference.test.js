/**
 * Unit + integration tests for client-preference → endpoint routing.
 *
 * The decision logic is exercised against the REAL resolveTargetFormat
 * (the same function chatCore.js calls), not a local copy. The
 * execute → buildUrl → fetch chain is verified by mocking proxyAwareFetch
 * and asserting the fetched URL end-to-end.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock the network layer so executor.execute() runs without real I/O.
// proxyFetch captures `globalThis.fetch` at module load, so we mock the whole
// module to avoid that stale-capture problem.
vi.mock("open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: vi.fn(async () => ({ ok: true, status: 200 })),
}));

import { getClientPreferredFormat, resolveTargetFormat } from "open-sse/utils/clientDetector.js";
import { getModelSupportedFormats, PROVIDER_ID_TO_ALIAS } from "open-sse/config/providerModels.js";
import { OpenCodeGoExecutor } from "open-sse/executors/opencode-go.js";
import { proxyAwareFetch } from "open-sse/utils/proxyFetch.js";

const OC_GO = PROVIDER_ID_TO_ALIAS["opencode-go"]; // === "opencode-go" (no alias override)

describe("getClientPreferredFormat", () => {
  it("maps claude → claude (Anthropic /messages)", () => {
    expect(getClientPreferredFormat("claude")).toBe("claude");
  });

  it("maps codex → openai-responses (/responses)", () => {
    expect(getClientPreferredFormat("codex")).toBe("openai-responses");
  });

  it("returns null for clients without a native preference", () => {
    for (const c of ["gemini-cli", "antigravity", "github-copilot", null, undefined]) {
      expect(getClientPreferredFormat(c)).toBeNull();
    }
  });
});

describe("getModelSupportedFormats (opencode-go)", () => {
  it("declares [openai, claude] for MiniMax models", () => {
    expect(getModelSupportedFormats(OC_GO, "minimax-m2.7")).toEqual(["openai", "claude"]);
    expect(getModelSupportedFormats(OC_GO, "minimax-m2.5")).toEqual(["openai", "claude"]);
  });

  it("declares [openai, claude] for qwen3.6-plus", () => {
    expect(getModelSupportedFormats(OC_GO, "qwen3.6-plus")).toEqual(["openai", "claude"]);
  });

  it("declares all three formats for deepseek models", () => {
    expect(getModelSupportedFormats(OC_GO, "deepseek-v4-pro")).toEqual(["openai", "claude", "openai-responses"]);
    expect(getModelSupportedFormats(OC_GO, "deepseek-v4-flash")).toEqual(["openai", "claude", "openai-responses"]);
  });

  it("returns null for openai-only models (no declaration → fallback)", () => {
    expect(getModelSupportedFormats(OC_GO, "kimi-k2.6")).toBeNull();
    expect(getModelSupportedFormats(OC_GO, "glm-5.1")).toBeNull();
    expect(getModelSupportedFormats(OC_GO, "mimo-v2-pro")).toBeNull();
  });

  it("returns null for unknown alias / model", () => {
    expect(getModelSupportedFormats("no-such-provider", "x")).toBeNull();
    expect(getModelSupportedFormats(OC_GO, "no-such-model")).toBeNull();
  });
});

// Directly test the REAL resolveTargetFormat across all branches.
describe("resolveTargetFormat (real function, all branches)", () => {
  it("returns preferred when model declares support", () => {
    expect(resolveTargetFormat({
      preferredFormat: "claude", supportedFormats: ["openai", "claude"],
      modelTargetFormat: null, providerDefault: "openai",
    })).toBe("claude");
  });

  it("falls back when preferred is not in supportedFormats", () => {
    expect(resolveTargetFormat({
      preferredFormat: "openai-responses", supportedFormats: ["openai", "claude"],
      modelTargetFormat: null, providerDefault: "openai",
    })).toBe("openai");
  });

  it("falls back when supportedFormats is null (undeclared)", () => {
    expect(resolveTargetFormat({
      preferredFormat: "claude", supportedFormats: null,
      modelTargetFormat: null, providerDefault: "openai",
    })).toBe("openai");
  });

  it("falls back when preferredFormat is null (no client preference)", () => {
    expect(resolveTargetFormat({
      preferredFormat: null, supportedFormats: ["openai", "claude"],
      modelTargetFormat: null, providerDefault: "openai",
    })).toBe("openai");
  });

  it("prefers modelTargetFormat over providerDefault on fallback", () => {
    expect(resolveTargetFormat({
      preferredFormat: null, supportedFormats: null,
      modelTargetFormat: "claude", providerDefault: "openai",
    })).toBe("claude");
  });

  it("uses providerDefault when modelTargetFormat is also null", () => {
    expect(resolveTargetFormat({
      preferredFormat: null, supportedFormats: null,
      modelTargetFormat: null, providerDefault: "gemini",
    })).toBe("gemini");
  });
});

// End-to-end decision per (client × opencode-go model), using the real helpers.
describe("targetFormat decision matrix (opencode-go, real functions)", () => {
  const providerDefault = "openai"; // opencode-go provider format

  const cases = [
    // Claude Code client — prefers claude
    { client: "claude", model: "minimax-m2.7", expected: "claude" },      // hit → native /messages
    { client: "claude", model: "qwen3.6-plus", expected: "claude" },      // hit → native /messages
    { client: "claude", model: "deepseek-v4-pro", expected: "claude" },   // hit (supports claude)
    { client: "claude", model: "kimi-k2.6", expected: "openai" },         // miss → fallback
    { client: "claude", model: "glm-5", expected: "openai" },             // miss → fallback
    // Codex client — prefers openai-responses
    { client: "codex", model: "deepseek-v4-pro", expected: "openai-responses" }, // hit → native /responses
    { client: "codex", model: "minimax-m2.7", expected: "openai" },       // miss (no responses support)
    { client: "codex", model: "kimi-k2.6", expected: "openai" },          // miss → fallback
    // No preference (generic OpenAI client) — always fallback
    { client: null, model: "minimax-m2.7", expected: "openai" },          // behavior change vs old hard-bind
    { client: null, model: "deepseek-v4-pro", expected: "openai" },
  ];

  for (const { client, model, expected } of cases) {
    it(`${client ?? "generic"} → ${model} resolves targetFormat=${expected}`, () => {
      const targetFormat = resolveTargetFormat({
        preferredFormat: getClientPreferredFormat(client),
        supportedFormats: getModelSupportedFormats(OC_GO, model),
        modelTargetFormat: null, // opencode-go models no longer carry targetFormat
        providerDefault,
      });
      expect(targetFormat).toBe(expected);
    });
  }
});

describe("OpenCodeGoExecutor endpoint selection by targetFormat", () => {
  const exec = new OpenCodeGoExecutor();
  const BASE = "https://opencode.ai/zen/go/v1";

  it("routes claude → /messages", () => {
    exec._targetFormat = "claude";
    expect(exec.buildUrl("minimax-m2.7")).toBe(`${BASE}/messages`);
  });

  it("routes openai-responses → /responses", () => {
    exec._targetFormat = "openai-responses";
    expect(exec.buildUrl("deepseek-v4-pro")).toBe(`${BASE}/responses`);
  });

  it("routes openai (default) → /chat/completions", () => {
    exec._targetFormat = "openai";
    expect(exec.buildUrl("kimi-k2.6")).toBe(`${BASE}/chat/completions`);
  });

  it("treats null targetFormat as default → /chat/completions", () => {
    exec._targetFormat = null;
    expect(exec.buildUrl("kimi-k2.6")).toBe(`${BASE}/chat/completions`);
  });

  it("uses x-api-key + anthropic-version auth for claude format", () => {
    exec._targetFormat = "claude";
    const h = exec.buildHeaders({ apiKey: "sk-test" });
    expect(h["x-api-key"]).toBe("sk-test");
    expect(h["anthropic-version"]).toBe("2023-06-01");
    expect(h["Authorization"]).toBeUndefined();
  });

  it("uses Bearer auth for non-claude formats", () => {
    exec._targetFormat = "openai";
    const h = exec.buildHeaders({ apiKey: "sk-test" });
    expect(h["Authorization"]).toBe("Bearer sk-test");
    expect(h["x-api-key"]).toBeUndefined();
  });
});

// Integration: verify the FULL chain execute() → this._targetFormat → buildUrl → fetch URL.
// This catches any wiring bug between chatCore passing targetFormat and the
// executor actually selecting the endpoint.
describe("OpenCodeGoExecutor.execute → endpoint (integration, mocked fetch)", () => {
  const exec = new OpenCodeGoExecutor();
  const baseArgs = { body: { messages: [] }, stream: false, credentials: { apiKey: "sk-test" }, log: {} };

  beforeEach(() => proxyAwareFetch.mockClear());

  it("forwards claude targetFormat and fetches /messages", async () => {
    const r = await exec.execute({ ...baseArgs, model: "minimax-m2.7", targetFormat: "claude" });
    expect(r.url).toBe("https://opencode.ai/zen/go/v1/messages");
    expect(proxyAwareFetch).toHaveBeenCalledTimes(1);
    expect(proxyAwareFetch.mock.calls[0][0]).toBe("https://opencode.ai/zen/go/v1/messages");
  });

  it("forwards openai-responses targetFormat and fetches /responses", async () => {
    const r = await exec.execute({ ...baseArgs, model: "deepseek-v4-pro", targetFormat: "openai-responses" });
    expect(r.url).toBe("https://opencode.ai/zen/go/v1/responses");
  });

  it("forwards openai targetFormat and fetches /chat/completions", async () => {
    const r = await exec.execute({ ...baseArgs, model: "kimi-k2.6", targetFormat: "openai" });
    expect(r.url).toBe("https://opencode.ai/zen/go/v1/chat/completions");
  });

  it("omits targetFormat → falls back to /chat/completions (backward-compatible)", async () => {
    const r = await exec.execute({ ...baseArgs, model: "kimi-k2.6" });
    expect(r.url).toBe("https://opencode.ai/zen/go/v1/chat/completions");
  });
});
