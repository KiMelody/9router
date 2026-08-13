/**
 * Detect CLI tool identity from request headers/body.
 * Used to determine if a request can be passed through losslessly.
 */

// Map of CLI tool identifiers to provider IDs they are "native" to
const NATIVE_PAIRS = {
  "claude":      ["claude", "anthropic"],
  "gemini-cli":  ["gemini-cli"],
  "antigravity": ["antigravity"],
  "codex":       ["codex"],
};

/**
 * Detect which CLI tool is making the request.
 * Returns one of: "claude" | "gemini-cli" | "antigravity" | "codex" | null
 * @param {object} headers - Lowercase header key/value object
 * @param {object} body    - Parsed request body
 */
export function detectClientTool(headers = {}, body = {}) {
  const ua = (headers["user-agent"] || "").toLowerCase();
  const xApp = (headers["x-app"] || "").toLowerCase();
  const openaiIntent = (headers["openai-intent"] || "").toLowerCase();
  const initiator = (headers["x-initiator"] || headers["X-Initiator"] || "").toLowerCase();

  // Antigravity: detected via body field (not header)
  if (body.userAgent === "antigravity") return "antigravity";

  // GitHub Copilot / OAI compatible extension using Copilot chat headers
  if (ua.includes("githubcopilotchat") || openaiIntent === "conversation-panel" || initiator === "user") {
    return "github-copilot";
  }

  // Claude Code / Claude CLI
  if (ua.includes("claude-cli") || ua.includes("claude-code") || xApp === "cli") return "claude";

  // Gemini CLI
  if (ua.includes("gemini-cli")) return "gemini-cli";

  // Codex CLI
  if (ua.includes("codex-cli")) return "codex";

  return null;
}

/**
 * Check if this CLI tool + provider pair should be passed through losslessly.
 * @param {string|null} clientTool - Result of detectClientTool()
 * @param {string} provider        - Provider ID (e.g. "claude", "gemini-cli")
 */
export function isNativePassthrough(clientTool, provider) {
  if (!clientTool) return false;
  const nativeProviders = NATIVE_PAIRS[clientTool];
  if (!nativeProviders) return false;
  // Support anthropic-compatible-* variants
  const normalizedProvider = provider.startsWith("anthropic-compatible")
    ? "anthropic"
    : provider;
  return nativeProviders.includes(normalizedProvider);
}

// Preferred upstream format per CLI client. When a model declares support for
// this format (supportedFormats in providerModels), the request is routed to
// the matching native endpoint to avoid lossy double-hop translation.
const CLIENT_PREFERRED_FORMAT = {
  claude: "claude",                 // Claude Code → Anthropic /messages
  codex: "openai-responses",        // Codex CLI → OpenAI Responses /responses
};

/**
 * Get the client's preferred upstream format, if any.
 * @param {string|null} clientTool - Result of detectClientTool()
 * @returns {string|null} e.g. "claude" | "openai-responses"
 */
export function getClientPreferredFormat(clientTool) {
  if (!clientTool) return null;
  return CLIENT_PREFERRED_FORMAT[clientTool] || null;
}
