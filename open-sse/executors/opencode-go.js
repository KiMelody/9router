import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import { injectReasoningContent } from "../utils/reasoningContentInjector.js";

const BASE = "https://opencode.ai/zen/go/v1";

export class OpenCodeGoExecutor extends BaseExecutor {
  constructor() {
    super("opencode-go", PROVIDERS["opencode-go"]);
  }

  // Endpoint is chosen by the resolved targetFormat (cached on this instance by
  // BaseExecutor.execute from chatCore's client-preference decision), not by model.
  // buildUrl runs before buildHeaders in BaseExecutor.execute; cache model here too.
  buildUrl(model) {
    this._lastModel = model;
    if (this._targetFormat === "openai-responses") return `${BASE}/responses`;
    return this._targetFormat === "claude" ? `${BASE}/messages` : `${BASE}/chat/completions`;
  }

  buildHeaders(credentials, stream = true) {
    const key = credentials?.apiKey || credentials?.accessToken;
    const headers = { "Content-Type": "application/json" };

    // Claude format → Anthropic-style x-api-key auth; others → Bearer
    if (this._targetFormat === "claude") {
      headers["x-api-key"] = key;
      headers["anthropic-version"] = "2023-06-01";
    } else {
      headers["Authorization"] = `Bearer ${key}`;
    }

    if (stream) headers["Accept"] = "text/event-stream";
    return headers;
  }

  transformRequest(model, body) {
    return injectReasoningContent({ provider: this.provider, model, body });
  }
}
