/**
 * Unit tests for client-preference → endpoint routing.
 *
 * Covers the decision chain introduced for "route by CLI client":
 *   clientTool → getClientPreferredFormat → getModelSupportedFormats → targetFormat → endpoint
 *
 * Tested at three layers:
 *   1. Pure helpers (getClientPreferredFormat, getModelSupportedFormats)
 *   2. The targetFormat decision rule (mirrors chatCore.js inline logic)
 *   3. OpenCodeGoExecutor endpoint/auth selection by resolved targetFormat
 */

import { describe, it, expect } from "vitest";
import { getClientPreferredFormat } from "open-sse/utils/clientDetector.js";
import { getModelSupportedFormats, PROVIDER_ID_TO_ALIAS } from "open-sse/config/providerModels.js";
import { OpenCodeGoExecutor } from "open-sse/executors/opencode-go.js";

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
});

// Mirror of chatCore.js targetFormat decision (soft-preference with fallback).
function resolveTargetFormat(preferred, supported, modelDefault, providerDefault) {
  if (preferred && supported?.includes(preferred)) return preferred;
  return modelDefault || providerDefault;
}

describe("targetFormat decision matrix", () => {
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
      const preferred = getClientPreferredFormat(client);
      const supported = getModelSupportedFormats(OC_GO, model);
      const targetFormat = resolveTargetFormat(preferred, supported, null, providerDefault);
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
