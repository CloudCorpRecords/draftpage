/**
 * draftpage core: a forwarding client for the hosted
 * Landing en 24h MCP server.
 *
 * No page, price or catalogue data lives on this
 * machine. tools/list is answered from the literal
 * definitions below, which reproduce a live capture of
 * the upstream server word for word (name, title,
 * description and inputSchema exactly as captured).
 * A tools/call travels upstream over a streamable-HTTP
 * JSON-RPC session: an initialize POST, a
 * notifications/initialized POST, then the tools/call
 * POST, carrying the Mcp-Session-Id response header on
 * later requests when the upstream issues one. The
 * session opens lazily on the first forwarded call and
 * is reused for the client's lifetime.
 *
 * The surface is a labelled subset of the capture.
 * Eight captured tools are deliberately NOT registered
 * here: `ar_dolar`, `ar_inflacion`, `ar_feriados`,
 * `ar_cuit`, `ar_cbu`, `ar_phone`, `fx_rate` and
 * `web_audit`. Each of them is priced per call in USDC
 * via x402 in its own captured description, and this
 * rebuild never originates payment, so no x402 payment
 * header is ever constructed or sent. The kept tools
 * are the server's free core: `generate_landing_page`
 * builds a landing page from a deterministic template
 * and stores nothing, `get_service_info` reads the
 * published done-for-you service description, and
 * `list_paid_apis` reads the published catalogue of
 * pay-per-call APIs — reading that catalogue is free
 * and buys nothing.
 *
 * The endpoint is pinned to https://landingen24h.com/mcp
 * and may be replaced with the LANDINGEN24H_MCP_URL
 * environment variable (that override is a labelled
 * reconstruction). The registry record declares NO
 * headers on the remote: no auth header is ever sent,
 * under any environment.
 *
 * A successful upstream result is returned exactly as
 * received, isError flag and extra fields included.
 * Failures — an upstream JSON-RPC error, a non-2xx
 * status, a body that cannot be parsed, or a fetch that
 * throws or times out — become an isError result whose
 * text begins with `draftpage error:` (that rendering
 * is a labelled reconstruction). Replies may be plain
 * JSON or SSE (`data:` lines); the JSON-RPC message
 * whose id matches the request wins.
 */
import type {
  FetchFn,
  FetchResponseLike,
  ForwardDeps,
  ToolArgs,
  ToolDef,
  ToolResult,
} from "./types.js";

export const VERSION = "0.1.0";

export const DEFAULT_ENDPOINT_URL = "https://landingen24h.com/mcp";

export const DEFAULT_TIMEOUT_MS = 30000;

export const PROTOCOL_VERSION = "2025-03-26";

/* ------------------------------------------------------------------ */
/* Tool definitions (tools/list literals, verbatim from the live       */
/* capture in harness/fixtures/landingen24h-tools-original.json;       */
/* generated programmatically by parsing and re-serialising the        */
/* fixture JSON, never retyped)                                        */
/* ------------------------------------------------------------------ */

// TOOL_DEFS_GENERATED_START
export const TOOL_DEFS: ToolDef[] = [
  {
    "name": "generate_landing_page",
    "title": "Generate landing page",
    "description": "Generate a complete, responsive single-file HTML landing page for a small business: hero, services, WhatsApp/email call to action, contact section and footer, with inline CSS and SEO meta tags. Requires business_name; optional tagline, description, services, city, whatsapp, email, language (es|en), color and cta_text. Returns the HTML document as text. Free, deterministic template, nothing is stored.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "business_name": {
          "type": "string",
          "maxLength": 80,
          "description": "Business or project name (required)"
        },
        "tagline": {
          "type": "string",
          "maxLength": 140,
          "description": "Short headline, e.g. 'Plumbing repairs in 24 hours'"
        },
        "description": {
          "type": "string",
          "maxLength": 600,
          "description": "One or two sentences about the business"
        },
        "services": {
          "type": "array",
          "maxItems": 8,
          "items": {
            "type": "string",
            "maxLength": 200
          },
          "description": "Up to 8 services. Use 'Title: short description' to add a description. GET: comma-separated"
        },
        "city": {
          "type": "string",
          "maxLength": 80,
          "description": "City or area served"
        },
        "whatsapp": {
          "type": "string",
          "maxLength": 24,
          "description": "WhatsApp number in international format, digits only, e.g. 5491122334455"
        },
        "email": {
          "type": "string",
          "maxLength": 120,
          "description": "Contact email"
        },
        "language": {
          "type": "string",
          "enum": [
            "es",
            "en"
          ],
          "default": "es",
          "description": "Page language"
        },
        "color": {
          "type": "string",
          "pattern": "^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$",
          "description": "Brand color as hex, e.g. #0f766e"
        },
        "cta_text": {
          "type": "string",
          "maxLength": 40,
          "description": "Main button text"
        }
      },
      "required": [
        "business_name"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "get_service_info",
    "title": "Done-for-you landing page service",
    "description": "Describe the done-for-you service: a custom landing page written, designed and published in 24 hours, with a free draft first and payment (USDT/USDC) only if the client likes it. Returns prices, what is included and how to order.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "language": {
          "type": "string",
          "enum": [
            "en",
            "es"
          ],
          "default": "en",
          "description": "Answer language"
        }
      },
      "additionalProperties": false
    }
  },
  {
    "name": "list_paid_apis",
    "title": "Pay-per-call APIs (x402)",
    "description": "List this server's pay-per-call HTTP APIs that agents can buy with USDC via x402 (Base, Polygon or Solana), with URL, price, input schema and an example: Argentina dolar quotes (oficial, blue, MEP, CCL, cripto, tarjeta) and FX exchange rate (0.002), Argentine CUIT/CUIL and CBU/CVU validators and Argentine phone normalizer to E.164 + WhatsApp link (0.01), web page SEO/security audit (0.02) and the landing page generator (0.25). Invalid input is never charged. Free to call; returns JSON text.",
    "inputSchema": {
      "type": "object",
      "properties": {},
      "additionalProperties": false
    }
  }
];
// TOOL_DEFS_GENERATED_END

export const TOOL_NAMES = TOOL_DEFS.map((t) => t.name);

/** Whether `name` belongs to the captured (subset) surface. */
export function isKnownTool(name: string): boolean {
  return TOOL_NAMES.includes(name);
}

/* ------------------------------------------------------------------ */
/* Forwarding client                                                   */
/* ------------------------------------------------------------------ */

function errorResult(detail: string): ToolResult {
  return {
    content: [{ type: "text", text: `draftpage error: ${detail}` }],
    isError: true,
  };
}

function rpcErrorMessage(error: unknown): string {
  if (error !== null && typeof error === "object") {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message !== "") return message;
    return JSON.stringify(error);
  }
  return String(error);
}

/**
 * Read a JSON-RPC response body, tolerating SSE framing.
 * Returns the message whose id matches `expectedId` when
 * present, otherwise the last parseable message, otherwise
 * null when nothing in the body parses.
 */
export function parseRpcBody(
  text: string,
  expectedId?: number,
): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  const candidates: Record<string, unknown>[] = [];
  const tryPush = (payload: string): void => {
    try {
      const parsed: unknown = JSON.parse(payload);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        candidates.push(parsed as Record<string, unknown>);
      }
    } catch {
      // Not a JSON payload; skip this candidate.
    }
  };
  if (trimmed.includes("data:")) {
    for (const line of trimmed.split("\n")) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      const payload = t.slice("data:".length).trim();
      if (payload !== "" && payload !== "[DONE]") tryPush(payload);
    }
  } else {
    tryPush(trimmed);
  }
  if (candidates.length === 0) return null;
  if (expectedId !== undefined) {
    const match = candidates.find((c) => c.id === expectedId);
    if (match !== undefined) return match;
  }
  return candidates[candidates.length - 1];
}

async function defaultFetch(
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
): Promise<FetchResponseLike> {
  return fetch(url, init) as unknown as FetchResponseLike;
}

/**
 * A forwarding client holding a single upstream session,
 * opened lazily on first use and reused from then on
 * (for the process lifetime in the MCP server, or for a
 * single invocation in the CLI).
 */
export class DraftpageClient {
  private readonly deps: ForwardDeps;
  private sessionId: string | null = null;
  private ready = false;
  private sessionPromise: Promise<void> | null = null;
  private idCounter = 0;

  constructor(deps: ForwardDeps = {}) {
    this.deps = deps;
  }

  private fetchFn(): FetchFn {
    return this.deps.fetchFn ?? defaultFetch;
  }

  private endpointUrl(): string {
    if (this.deps.url && this.deps.url.trim() !== "") return this.deps.url.trim();
    const raw = (this.deps.env ?? process.env).LANDINGEN24H_MCP_URL;
    if (raw && raw.trim() !== "") return raw.trim();
    return DEFAULT_ENDPOINT_URL;
  }

  private timeoutMs(): number {
    if (typeof this.deps.timeoutMs === "number" && this.deps.timeoutMs > 0) {
      return this.deps.timeoutMs;
    }
    return DEFAULT_TIMEOUT_MS;
  }

  private nextId(): number {
    this.idCounter += 1;
    return this.idCounter;
  }

  private async post(
    body: unknown,
    withSession: boolean,
  ): Promise<FetchResponseLike> {
    // The registry record declares NO headers on the remote:
    // no Authorization (or any other auth) header is ever sent,
    // and no x402 payment header is ever constructed or sent.
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    if (withSession && this.sessionId !== null) {
      headers["Mcp-Session-Id"] = this.sessionId;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs());
    try {
      return await this.fetchFn()(this.endpointUrl(), {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  private async ensureSession(): Promise<void> {
    if (this.ready) return;
    if (this.sessionPromise === null) {
      this.sessionPromise = (async () => {
        const initId = this.nextId();
        const initRes = await this.post(
          {
            jsonrpc: "2.0",
            id: initId,
            method: "initialize",
            params: {
              protocolVersion: PROTOCOL_VERSION,
              capabilities: {},
              clientInfo: { name: "draftpage", version: VERSION },
            },
          },
          false,
        );
        const sessionId = initRes.headers.get("mcp-session-id");
        if (sessionId) this.sessionId = sessionId;
        const initText = await initRes.text();
        const initParsed = parseRpcBody(initText, initId);
        if (initParsed !== null && initParsed.error) {
          throw new Error(rpcErrorMessage(initParsed.error));
        }
        if (initRes.status < 200 || initRes.status >= 300) {
          throw new Error(`HTTP ${initRes.status}`);
        }
        if (initParsed === null && initText.trim() !== "") {
          throw new Error("malformed response");
        }
        const initializedRes = await this.post(
          { jsonrpc: "2.0", method: "notifications/initialized" },
          true,
        );
        try {
          await initializedRes.text();
        } catch {
          // Nothing needed from the notification response body.
        }
        this.ready = true;
      })();
    }
    try {
      await this.sessionPromise;
    } catch (err) {
      this.sessionPromise = null;
      this.sessionId = null;
      throw err;
    }
  }

  /** Forward one tool call; upstream failures come back as isError results. */
  async callTool(name: string, args: ToolArgs): Promise<ToolResult> {
    try {
      await this.ensureSession();
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err));
    }

    const callId = this.nextId();
    let callRes: FetchResponseLike;
    try {
      callRes = await this.post(
        {
          jsonrpc: "2.0",
          id: callId,
          method: "tools/call",
          params: { name, arguments: args ?? {} },
        },
        true,
      );
    } catch (err) {
      return errorResult(
        `request failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const parsed = parseRpcBody(await callRes.text(), callId);
    if (parsed !== null && parsed.error) {
      return errorResult(rpcErrorMessage(parsed.error));
    }
    if (callRes.status < 200 || callRes.status >= 300) {
      return errorResult(`HTTP ${callRes.status}`);
    }
    if (parsed === null) return errorResult("malformed response");
    const result = parsed.result as ToolResult | undefined;
    if (result === undefined || result === null || typeof result !== "object") {
      return errorResult("malformed response");
    }
    // Hand the upstream result back exactly as received.
    return result;
  }
}

/** Build a forwarding client; tests inject a fake fetch and env through deps. */
export function createClient(deps: ForwardDeps = {}): DraftpageClient {
  return new DraftpageClient(deps);
}

/** One-shot helper: a fresh client for a single call (the CLI path). */
export async function callTool(
  name: string,
  args: ToolArgs,
  deps: ForwardDeps = {},
): Promise<ToolResult> {
  return new DraftpageClient(deps).callTool(name, args);
}
