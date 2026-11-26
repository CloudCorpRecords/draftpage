import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import {
  DraftpageClient,
  callTool,
  createClient,
  DEFAULT_ENDPOINT_URL,
  isKnownTool,
  parseRpcBody,
  PROTOCOL_VERSION,
  TOOL_DEFS,
  TOOL_NAMES,
  VERSION,
} from "../src/forward.js";
import { createServer, handleCallTool } from "../src/mcp.js";
import type {
  FetchFn,
  FetchResponseLike,
  ToolDef,
  ToolResult,
} from "../src/types.js";

/**
 * Every test runs against a stubbed JSON-RPC upstream that
 * implements the streamable-HTTP session flow
 * (initialize -> notifications/initialized -> tools/call):
 * no live network, and the real Landing en 24h endpoint
 * is never contacted.
 */

const FIXTURE_PATH =
  "/home/hatch/workspace/mcp-rebuild-100/harness/fixtures/landingen24h-tools-original.json";
const FIXTURE_AVAILABLE = existsSync(FIXTURE_PATH);
const fixture = (
  FIXTURE_AVAILABLE
    ? JSON.parse(readFileSync(FIXTURE_PATH, "utf-8"))
    : { tools: [] }
) as {
  tools: ToolDef[];
};
/**
 * Publish-survival guard (Wave 29 P1 preflight, proven Wave 24 pattern):
 * the parity fixture lives in the build harness, outside the published
 * repo tree, so fixture-dependent tests skip cleanly when it is absent;
 * with the fixture present they run in full, with no skips.
 */
function skipWithoutFixture(t: {
  skip: (message: string) => void;
}): boolean {
  if (FIXTURE_AVAILABLE) return false;
  t.skip("parity fixture lives in the build harness, not the repo tree");
  return true;
}


const GENERATE = "generate_landing_page";
const INFO = "get_service_info";
const APIS = "list_paid_apis";
const OMITTED_TOOLS = [
  "ar_dolar",
  "ar_inflacion",
  "ar_feriados",
  "ar_cuit",
  "ar_cbu",
  "ar_phone",
  "fx_rate",
  "web_audit",
];
const ALL_TOOLS = [GENERATE, INFO, APIS];

const SAMPLE_RESULT = {
  content: [
    {
      type: "text",
      text: "<!doctype html><html><body><h1>Acme Plumbing</h1></body></html>",
    },
  ],
  structuredContent: { business_name: "Acme Plumbing" },
};

const SAMPLE_ARGS = { business_name: "Acme Plumbing" };

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

interface FakeOptions {
  callResult?: Record<string, unknown>;
  callBodyText?: string;
  callError?: Record<string, unknown>;
  callStatus?: number;
  initError?: Record<string, unknown>;
  throwOn?: "initialize" | "tools/call";
  sessionId?: string | null;
  hangOnCall?: boolean;
  sse?: boolean;
}

function makeResponse(
  status: number,
  bodyText: string,
  headers: Record<string, string> = {},
): FetchResponseLike {
  const lowered = new Map(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]),
  );
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => lowered.get(name.toLowerCase()) ?? null },
    text: async () => bodyText,
  };
}

function jsonResponse(
  status: number,
  payload: unknown,
  headers: Record<string, string> = {},
) {
  return makeResponse(status, JSON.stringify(payload), headers);
}

function makeUpstream(options: FakeOptions = {}): {
  fetchFn: FetchFn;
  calls: Captured[];
} {
  const calls: Captured[] = [];
  const fetchFn: FetchFn = async (url, init) => {
    const body = JSON.parse(init?.body ?? "{}") as Record<string, unknown>;
    calls.push({ url, headers: init?.headers ?? {}, body });
    const method = body.method as string;
    if (options.throwOn === method) throw new Error("socket hang up");
    if (method === "initialize") {
      if (options.initError !== undefined) {
        return jsonResponse(200, {
          jsonrpc: "2.0",
          id: body.id,
          error: options.initError,
        });
      }
      const headers: Record<string, string> = {};
      const sessionId =
        options.sessionId === undefined ? "sess-abc" : options.sessionId;
      if (sessionId !== null) headers["mcp-session-id"] = sessionId;
      return jsonResponse(
        200,
        {
          jsonrpc: "2.0",
          id: body.id,
          result: {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: {},
            serverInfo: { name: "landingen24h", version: "1.3.0" },
          },
        },
        headers,
      );
    }
    if (method === "notifications/initialized") {
      return makeResponse(202, "");
    }
    if (method === "tools/call") {
      if (options.hangOnCall) {
        return new Promise<FetchResponseLike>((_resolve, reject) => {
          const signal = init?.signal;
          if (signal) {
            if (signal.aborted) {
              reject(new Error("aborted"));
              return;
            }
            signal.addEventListener("abort", () => reject(new Error("aborted")));
          }
        });
      }
      if (options.callBodyText !== undefined) {
        return makeResponse(options.callStatus ?? 200, options.callBodyText);
      }
      if (options.callError !== undefined) {
        return jsonResponse(200, {
          jsonrpc: "2.0",
          id: body.id,
          error: options.callError,
        });
      }
      const result = options.callResult ?? SAMPLE_RESULT;
      const payload = { jsonrpc: "2.0", id: body.id, result };
      if (options.sse) {
        return makeResponse(
          200,
          `event: message\ndata: ${JSON.stringify(payload)}\n\n`,
        );
      }
      return jsonResponse(options.callStatus ?? 200, payload);
    }
    return jsonResponse(200, {});
  };
  return { fetchFn, calls };
}

function stubClient(options: FakeOptions = {}, extra: Record<string, unknown> = {}) {
  const upstream = makeUpstream(options);
  const c = new DraftpageClient({
    fetchFn: upstream.fetchFn,
    env: {},
    ...extra,
  });
  return { client: c, calls: upstream.calls };
}

function textOf(result: ToolResult): string {
  const content = result.content as Array<{ type: string; text: string }>;
  return content[0].text;
}

function methods(calls: Captured[]): string[] {
  return calls.map((c) => c.body.method as string);
}

function schemaOf(tool: ToolDef): Record<string, any> {
  return tool.inputSchema as Record<string, any>;
}

function defOf(name: string): ToolDef {
  const def = TOOL_DEFS.find((t) => t.name === name);
  assert.ok(def !== undefined, `missing tool def ${name}`);
  return def;
}

/* CLI helpers (also used by the omission suite). Absolute paths only. */

const CLI_ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLI_PATH = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

function runCli(args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", CLI_PATH, ...args], {
    cwd: CLI_ROOT,
    encoding: "utf8",
    timeout: 30000,
  });
}

/* MCP client over an in-memory transport, for tools/list and
 * tools/call assertions at the MCP layer itself. */
async function withMcpClient<T>(
  upstream: { fetchFn: FetchFn },
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const server = createServer({ fetchFn: upstream.fetchFn, env: {} });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client(
    { name: "draftpage-test", version: "0.0.0" },
    { capabilities: {} },
  );
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    return await fn(client);
  } finally {
    await client.close();
    await server.close();
  }
}

/* ------------------------------------------------------------------ */

describe("registration integrity (captured surface)", () => {
  it("serves exactly the fixture's 3 tools, deep-equal, in order", (t) => {
    if (skipWithoutFixture(t)) return;
    assert.equal(fixture.tools.length, 3);
    assert.deepEqual(TOOL_DEFS, fixture.tools);
  });

  it("serves the 3 tool names in fixture order", () => {
    assert.deepEqual(TOOL_NAMES, ALL_TOOLS);
  });

  it("carries exactly the fixture's keys on every tool", () => {
    for (const tool of TOOL_DEFS) {
      assert.deepEqual(Object.keys(tool).sort(), [
        "description",
        "inputSchema",
        "name",
        "title",
      ]);
    }
  });

  it("carries the fixture's titles verbatim", () => {
    assert.deepEqual(
      TOOL_DEFS.map((t) => t.title),
      [
        "Generate landing page",
        "Done-for-you landing page service",
        "Pay-per-call APIs (x402)",
      ],
    );
  });

  it("carries the fixture's descriptions verbatim", (t) => {
    if (skipWithoutFixture(t)) return;
    for (let i = 0; i < TOOL_DEFS.length; i++) {
      assert.equal(TOOL_DEFS[i].description, fixture.tools[i].description);
    }
    assert.match(defOf(GENERATE).description, /Free, deterministic template, nothing is stored/);
    assert.match(defOf(INFO).description, /free draft first/);
    assert.match(defOf(APIS).description, /Free to call; returns JSON text/);
  });

  it("carries the required key exactly as captured on each tool", () => {
    assert.deepEqual(schemaOf(defOf(GENERATE)).required, ["business_name"]);
    assert.equal("required" in schemaOf(defOf(INFO)), false);
    assert.equal(schemaOf(defOf(INFO)).required, undefined);
    assert.equal("required" in schemaOf(defOf(APIS)), false);
    assert.equal(schemaOf(defOf(APIS)).required, undefined);
  });

  it("every inputSchema is an object schema with additionalProperties false and no $schema marker", () => {
    for (const tool of TOOL_DEFS) {
      assert.equal(schemaOf(tool).type, "object");
      assert.equal(schemaOf(tool).additionalProperties, false);
      assert.equal("$schema" in schemaOf(tool), false);
    }
  });

  it("carries every fixture property, in order, for every tool", (t) => {
    if (skipWithoutFixture(t)) return;
    for (let i = 0; i < TOOL_DEFS.length; i++) {
      const served = Object.keys(schemaOf(TOOL_DEFS[i]).properties);
      const expected = Object.keys(schemaOf(fixture.tools[i]).properties);
      assert.deepEqual(served, expected);
    }
    assert.deepEqual(Object.keys(schemaOf(defOf(GENERATE)).properties), [
      "business_name",
      "tagline",
      "description",
      "services",
      "city",
      "whatsapp",
      "email",
      "language",
      "color",
      "cta_text",
    ]);
    assert.deepEqual(Object.keys(schemaOf(defOf(INFO)).properties), ["language"]);
    assert.deepEqual(Object.keys(schemaOf(defOf(APIS)).properties), []);
  });

  it("generate_landing_page carries the captured string limits", () => {
    const props = schemaOf(defOf(GENERATE)).properties;
    assert.equal(props.business_name.type, "string");
    assert.equal(props.business_name.maxLength, 80);
    assert.equal(props.business_name.description, "Business or project name (required)");
    assert.equal(props.tagline.maxLength, 140);
    assert.equal(props.description.maxLength, 600);
    assert.equal(props.city.maxLength, 80);
    assert.equal(props.whatsapp.maxLength, 24);
    assert.equal(props.email.maxLength, 120);
    assert.equal(props.cta_text.maxLength, 40);
  });

  it("generate_landing_page carries the captured services array shape", () => {
    const services = schemaOf(defOf(GENERATE)).properties.services;
    assert.equal(services.type, "array");
    assert.equal(services.maxItems, 8);
    assert.deepEqual(services.items, { type: "string", maxLength: 200 });
    assert.match(services.description, /Up to 8 services/);
  });

  it("generate_landing_page language is enum es|en defaulting to es, and color carries the hex pattern", () => {
    const props = schemaOf(defOf(GENERATE)).properties;
    assert.deepEqual(props.language.enum, ["es", "en"]);
    assert.equal(props.language.default, "es");
    assert.equal(props.color.pattern, "^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$");
  });

  it("get_service_info language is enum en|es defaulting to en", () => {
    const language = schemaOf(defOf(INFO)).properties.language;
    assert.equal(language.type, "string");
    assert.deepEqual(language.enum, ["en", "es"]);
    assert.equal(language.default, "en");
    assert.equal(language.description, "Answer language");
  });

  it("list_paid_apis takes no properties at all", () => {
    assert.deepEqual(schemaOf(defOf(APIS)).properties, {});
  });

  it("isKnownTool recognises the built tools and rejects others", () => {
    for (const name of ALL_TOOLS) assert.equal(isKnownTool(name), true);
    assert.equal(isKnownTool("generate"), false);
    assert.equal(isKnownTool("landing"), false);
    assert.equal(isKnownTool(""), false);
  });
});

/* ------------------------------------------------------------------ */

describe("labelled omissions: the eight x402 pay-per-call tools are absent", () => {
  it("none of the eight omitted tools is among the served tool names (registry level)", () => {
    assert.equal(OMITTED_TOOLS.length, 8);
    for (const omitted of OMITTED_TOOLS) {
      assert.equal(TOOL_NAMES.includes(omitted), false);
      assert.equal(TOOL_DEFS.some((t) => t.name === omitted), false);
    }
    assert.equal(TOOL_DEFS.length, 3);
  });

  it("isKnownTool rejects all eight omitted tools (registry level)", () => {
    for (const omitted of OMITTED_TOOLS) {
      assert.equal(isKnownTool(omitted), false);
    }
  });

  for (const omitted of OMITTED_TOOLS) {
    it(`the MCP layer rejects ${omitted} as unknown, before any network hop`, async () => {
      const upstream = makeUpstream();
      const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
      await assert.rejects(
        () => handleCallTool(c, omitted, {}),
        (err: unknown) =>
          err instanceof McpError && err.code === ErrorCode.MethodNotFound,
      );
      assert.equal(upstream.calls.length, 0);
    });
  }

  it("the MCP tools/list response carries exactly the 3 built tools and none of the omitted eight", async (t) => {
    if (skipWithoutFixture(t)) return;
    const upstream = makeUpstream();
    const listed = await withMcpClient(upstream, async (client) => {
      const res = await client.listTools();
      return res.tools;
    });
    assert.deepEqual(
      listed.map((t) => t.name),
      ALL_TOOLS,
    );
    for (const omitted of OMITTED_TOOLS) {
      assert.equal(listed.some((t) => t.name === omitted), false);
    }
    assert.deepEqual(listed, fixture.tools);
    assert.equal(upstream.calls.length, 0);
  });

  for (const omitted of OMITTED_TOOLS) {
    it(`an MCP tools/call for ${omitted} is rejected and never reaches the upstream`, async () => {
      const upstream = makeUpstream();
      await withMcpClient(upstream, async (client) => {
        await assert.rejects(() =>
          client.callTool({ name: omitted, arguments: {} }),
        );
      });
      assert.equal(upstream.calls.length, 0);
    });
  }

  for (const omitted of OMITTED_TOOLS) {
    it(`the omitted ${omitted} tool is not a CLI command and exits 2`, () => {
      const res = runCli([omitted, "{}"]);
      assert.equal(res.status, 2);
      assert.match(res.stderr, /Usage:/);
      assert.doesNotMatch(res.stderr, new RegExp(`one of: [^\\n]*${omitted}`));
    });
  }
});

/* ------------------------------------------------------------------ */

describe("session establishment and reuse", () => {
  it("runs initialize, notifications/initialized, then tools/call in order", async () => {
    const { client: c, calls } = stubClient();
    const out = await c.callTool(GENERATE, SAMPLE_ARGS);
    assert.equal(out.isError, undefined);
    assert.deepEqual(methods(calls), [
      "initialize",
      "notifications/initialized",
      "tools/call",
    ]);
    assert.ok(calls.every((call) => call.url === DEFAULT_ENDPOINT_URL));
    assert.equal(DEFAULT_ENDPOINT_URL, "https://landingen24h.com/mcp");
    for (const call of calls) {
      assert.equal(call.headers["Content-Type"], "application/json");
      assert.equal(call.headers["Accept"], "application/json, text/event-stream");
    }
    assert.equal(calls[0].headers["Mcp-Session-Id"], undefined);
    assert.equal(calls[1].headers["Mcp-Session-Id"], "sess-abc");
    assert.equal(calls[2].headers["Mcp-Session-Id"], "sess-abc");
  });

  it("sends clientInfo name draftpage and the pinned protocol version on initialize", async () => {
    const { client: c, calls } = stubClient();
    await c.callTool(GENERATE, SAMPLE_ARGS);
    const initParams = calls[0].body.params as Record<string, unknown>;
    assert.equal(initParams.protocolVersion, PROTOCOL_VERSION);
    assert.equal(PROTOCOL_VERSION, "2025-03-26");
    assert.deepEqual(initParams.capabilities, {});
    assert.deepEqual(initParams.clientInfo, { name: "draftpage", version: VERSION });
  });

  it("establishes the session lazily once and reuses it on later calls", async () => {
    const { client: c, calls } = stubClient();
    await c.callTool(GENERATE, SAMPLE_ARGS);
    await c.callTool(APIS, {});
    assert.deepEqual(methods(calls), [
      "initialize",
      "notifications/initialized",
      "tools/call",
      "tools/call",
    ]);
    assert.equal(calls[3].headers["Mcp-Session-Id"], "sess-abc");
    assert.notEqual(calls[2].body.id, calls[3].body.id);
  });

  it("sends no session header when the upstream issues none", async () => {
    const { client: c, calls } = stubClient({ sessionId: null });
    const out = await c.callTool(GENERATE, SAMPLE_ARGS);
    assert.equal(out.isError, undefined);
    assert.ok(calls.every((call) => call.headers["Mcp-Session-Id"] === undefined));
  });

  it("honours the LANDINGEN24H_MCP_URL env override", async () => {
    const upstream = makeUpstream();
    const c = new DraftpageClient({
      fetchFn: upstream.fetchFn,
      env: { LANDINGEN24H_MCP_URL: "https://staging.example.com/mcp" },
    });
    await c.callTool(GENERATE, SAMPLE_ARGS);
    assert.ok(
      upstream.calls.every((call) => call.url === "https://staging.example.com/mcp"),
    );
  });

  it("honours an explicit url override over the default endpoint", async () => {
    const upstream = makeUpstream();
    const c = createClient({
      fetchFn: upstream.fetchFn,
      env: {},
      url: "https://alt.example.com/mcp",
    });
    await c.callTool(GENERATE, SAMPLE_ARGS);
    assert.ok(upstream.calls.every((call) => call.url === "https://alt.example.com/mcp"));
  });

  it("prefers an explicit url override over the env override", async () => {
    const upstream = makeUpstream();
    const c = createClient({
      fetchFn: upstream.fetchFn,
      env: { LANDINGEN24H_MCP_URL: "https://env.example.com/mcp" },
      url: "https://explicit.example.com/mcp",
    });
    await c.callTool(GENERATE, SAMPLE_ARGS);
    assert.ok(
      upstream.calls.every((call) => call.url === "https://explicit.example.com/mcp"),
    );
  });

  it("falls back to the pinned endpoint when the env override is blank", async () => {
    const upstream = makeUpstream();
    const c = new DraftpageClient({
      fetchFn: upstream.fetchFn,
      env: { LANDINGEN24H_MCP_URL: "   " },
    });
    await c.callTool(GENERATE, SAMPLE_ARGS);
    assert.ok(upstream.calls.every((call) => call.url === DEFAULT_ENDPOINT_URL));
  });
});

/* ------------------------------------------------------------------ */

describe("no auth header and no x402 payment header is ever sent", () => {
  it("sends no Authorization header when the environment is empty", async () => {
    const { client: c, calls } = stubClient();
    await c.callTool(GENERATE, SAMPLE_ARGS);
    assert.equal(calls.length, 3);
    assert.ok(calls.every((call) => call.headers["Authorization"] === undefined));
  });

  it("sends no Authorization header even when a LANDINGEN24H_API_KEY-style env var is present", async () => {
    const upstream = makeUpstream();
    const c = new DraftpageClient({
      fetchFn: upstream.fetchFn,
      env: { LANDINGEN24H_API_KEY: "some-key-42" },
    });
    await c.callTool(GENERATE, SAMPLE_ARGS);
    assert.ok(
      upstream.calls.every((call) => call.headers["Authorization"] === undefined),
    );
  });

  it("sends no Authorization header even when AUTHORIZATION / API_KEY env vars are present", async () => {
    const upstream = makeUpstream();
    const c = new DraftpageClient({
      fetchFn: upstream.fetchFn,
      env: {
        AUTHORIZATION: "Bearer x",
        API_KEY: "y",
        LANDINGEN24H_TOKEN: "z",
      },
    });
    await c.callTool(INFO, { language: "en" });
    assert.ok(
      upstream.calls.every((call) => call.headers["Authorization"] === undefined),
    );
  });

  it("never sends an X-API-Key header either", async () => {
    const upstream = makeUpstream();
    const c = new DraftpageClient({
      fetchFn: upstream.fetchFn,
      env: { LANDINGEN24H_API_KEY: "some-key-42" },
    });
    await c.callTool(GENERATE, SAMPLE_ARGS);
    assert.ok(upstream.calls.every((call) => call.headers["X-API-Key"] === undefined));
  });

  it("never sends any x402 or payment header, under any environment", async () => {
    const upstream = makeUpstream();
    const c = new DraftpageClient({
      fetchFn: upstream.fetchFn,
      env: {
        X402_PAYMENT: "should-never-be-forwarded",
        PAYMENT_SIGNATURE: "should-never-be-forwarded",
      },
    });
    await c.callTool(APIS, {});
    assert.equal(upstream.calls.length, 3);
    for (const call of upstream.calls) {
      for (const key of Object.keys(call.headers)) {
        const lowered = key.toLowerCase();
        assert.equal(lowered.includes("x402"), false, `header ${key} sent`);
        assert.equal(lowered.includes("payment"), false, `header ${key} sent`);
      }
      assert.equal(call.headers["X-PAYMENT"], undefined);
      assert.equal(call.headers["PAYMENT-SIGNATURE"], undefined);
      assert.equal(call.headers["X-Payment-Signature"], undefined);
    }
  });

  it("sends only Content-Type, Accept and (when issued) Mcp-Session-Id headers", async () => {
    const { client: c, calls } = stubClient();
    await c.callTool(GENERATE, SAMPLE_ARGS);
    assert.deepEqual(Object.keys(calls[0].headers).sort(), [
      "Accept",
      "Content-Type",
    ]);
    assert.deepEqual(Object.keys(calls[2].headers).sort(), [
      "Accept",
      "Content-Type",
      "Mcp-Session-Id",
    ]);
  });
});

/* ------------------------------------------------------------------ */

describe("tools/call forwarding", () => {
  it("forwards a generate_landing_page call verbatim with its business_name", async () => {
    const { client: c, calls } = stubClient();
    await c.callTool(GENERATE, SAMPLE_ARGS);
    const params = calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, GENERATE);
    assert.deepEqual(params.arguments, SAMPLE_ARGS);
  });

  it("forwards a get_service_info call under its own name with its language", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    await c.callTool(INFO, { language: "es" });
    const params = upstream.calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, INFO);
    assert.deepEqual(params.arguments, { language: "es" });
  });

  it("forwards a list_paid_apis call under its own name with empty arguments", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    await c.callTool(APIS, {});
    const params = upstream.calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, APIS);
    assert.deepEqual(params.arguments, {});
  });

  it("passes the upstream result through verbatim, including extra fields", async () => {
    const { client: c } = stubClient();
    const out = await c.callTool(GENERATE, SAMPLE_ARGS);
    assert.deepEqual(out, SAMPLE_RESULT);
  });

  it("passes an upstream isError result through untouched", async () => {
    const upstreamResult = {
      content: [{ type: "text", text: "business_name missing upstream" }],
      isError: true,
    };
    const { client: c } = stubClient({ callResult: upstreamResult });
    const out = await c.callTool(GENERATE, {});
    assert.deepEqual(out, upstreamResult);
  });

  it("reads an SSE-framed tools/call response", async () => {
    const { client: c } = stubClient({ sse: true });
    const out = await c.callTool(GENERATE, SAMPLE_ARGS);
    assert.equal(out.isError, undefined);
    assert.deepEqual(out, SAMPLE_RESULT);
  });

  it("the one-shot callTool helper forwards under the right tool name", async () => {
    const upstream = makeUpstream();
    const out = await callTool(
      INFO,
      { language: "en" },
      { fetchFn: upstream.fetchFn, env: {} },
    );
    assert.equal(out.isError, undefined);
    const params = upstream.calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, INFO);
    assert.deepEqual(params.arguments, { language: "en" });
  });
});

/* ------------------------------------------------------------------ */

describe("upstream failures surface as draftpage error text", () => {
  it("maps a JSON-RPC error to `draftpage error: <message>`", async () => {
    const { client: c } = stubClient({
      callError: { code: -32000, message: "generation failed upstream" },
    });
    const out = await c.callTool(GENERATE, SAMPLE_ARGS);
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "draftpage error: generation failed upstream");
  });

  it("maps an initialize JSON-RPC error to draftpage error text", async () => {
    const { client: c } = stubClient({
      initError: { code: -32600, message: "bad initialize" },
    });
    const out = await c.callTool(GENERATE, SAMPLE_ARGS);
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "draftpage error: bad initialize");
  });

  it("maps an unparseable upstream response to a malformed-response error", async () => {
    const { client: c } = stubClient({ callBodyText: "<html>oops</html>" });
    const out = await c.callTool(GENERATE, SAMPLE_ARGS);
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "draftpage error: malformed response");
  });

  it("maps a response with no result object to a malformed-response error", async () => {
    const { client: c } = stubClient({
      callBodyText: '{"jsonrpc":"2.0","id":3,"result":null}',
    });
    const out = await c.callTool(GENERATE, SAMPLE_ARGS);
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "draftpage error: malformed response");
  });

  it("maps a non-2xx upstream status to draftpage error text", async () => {
    const { client: c } = stubClient({ callBodyText: "internal error", callStatus: 500 });
    const out = await c.callTool(GENERATE, SAMPLE_ARGS);
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "draftpage error: HTTP 500");
  });

  it("maps a throwing fetch to draftpage error text", async () => {
    const { client: c } = stubClient({ throwOn: "tools/call" });
    const out = await c.callTool(GENERATE, SAMPLE_ARGS);
    assert.equal(out.isError, true);
    assert.match(textOf(out), /^draftpage error: /);
  });

  it("maps a throwing initialize fetch to draftpage error text", async () => {
    const { client: c } = stubClient({ throwOn: "initialize" });
    const out = await c.callTool(GENERATE, SAMPLE_ARGS);
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "draftpage error: socket hang up");
  });

  it("maps a timed-out call to draftpage error text", async () => {
    const { client: c } = stubClient({ hangOnCall: true }, { timeoutMs: 20 });
    const out = await c.callTool(GENERATE, SAMPLE_ARGS);
    assert.equal(out.isError, true);
    assert.match(textOf(out), /^draftpage error: /);
  });
});

/* ------------------------------------------------------------------ */

describe("parseRpcBody", () => {
  it("parses plain JSON and picks the message with the matching id", () => {
    const body = '{"jsonrpc":"2.0","id":7,"result":{"ok":true}}';
    assert.deepEqual(parseRpcBody(body, 7), {
      jsonrpc: "2.0",
      id: 7,
      result: { ok: true },
    });
  });

  it("parses SSE data lines", () => {
    const body =
      'event: message\ndata: {"jsonrpc":"2.0","id":2,"result":{"ok":true}}\n\n';
    assert.deepEqual(parseRpcBody(body, 2), {
      jsonrpc: "2.0",
      id: 2,
      result: { ok: true },
    });
  });

  it("picks the matching id among several SSE messages", () => {
    const body =
      'data: {"jsonrpc":"2.0","id":1,"result":{"n":1}}\n\n' +
      'data: {"jsonrpc":"2.0","id":2,"result":{"n":2}}\n\n';
    assert.deepEqual(parseRpcBody(body, 2), {
      jsonrpc: "2.0",
      id: 2,
      result: { n: 2 },
    });
  });

  it("ignores the SSE [DONE] sentinel", () => {
    const body =
      'data: {"jsonrpc":"2.0","id":4,"result":{"ok":true}}\ndata: [DONE]\n';
    assert.deepEqual(parseRpcBody(body, 4), {
      jsonrpc: "2.0",
      id: 4,
      result: { ok: true },
    });
  });

  it("returns null for empty and unparseable bodies", () => {
    assert.equal(parseRpcBody(""), null);
    assert.equal(parseRpcBody("not json at all"), null);
    assert.equal(parseRpcBody("[1,2,3]"), null);
  });
});

/* ------------------------------------------------------------------ */

describe("MCP layer validation", () => {
  it("rejects an unknown tool with MethodNotFound before any network hop", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    await assert.rejects(
      () => handleCallTool(c, "not_a_tool", {}),
      (err: unknown) =>
        err instanceof McpError && err.code === ErrorCode.MethodNotFound,
    );
    assert.equal(upstream.calls.length, 0);
  });

  it("rejects array arguments with InvalidParams before any network hop", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    await assert.rejects(
      () => handleCallTool(c, GENERATE, ["nope"]),
      (err: unknown) =>
        err instanceof McpError && err.code === ErrorCode.InvalidParams,
    );
    assert.equal(upstream.calls.length, 0);
  });

  it("rejects string arguments with InvalidParams before any network hop", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    await assert.rejects(
      () => handleCallTool(c, GENERATE, "business_name=Acme"),
      (err: unknown) =>
        err instanceof McpError && err.code === ErrorCode.InvalidParams,
    );
    assert.equal(upstream.calls.length, 0);
  });

  it("forwards a valid generate_landing_page call through the MCP layer unchanged", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    const out = await handleCallTool(c, GENERATE, SAMPLE_ARGS);
    assert.deepEqual(out, SAMPLE_RESULT);
    const params = upstream.calls[2].body.params as Record<string, unknown>;
    assert.deepEqual(params.arguments, SAMPLE_ARGS);
  });

  it("forwards a valid list_paid_apis call through the MCP layer unchanged", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    const out = await handleCallTool(c, APIS, {});
    assert.deepEqual(out, SAMPLE_RESULT);
    const params = upstream.calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, APIS);
    assert.deepEqual(params.arguments, {});
  });

  it("treats omitted arguments as an empty object", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    const out = await handleCallTool(c, APIS, undefined);
    assert.deepEqual(out, SAMPLE_RESULT);
    const params = upstream.calls[2].body.params as Record<string, unknown>;
    assert.deepEqual(params.arguments, {});
  });
});

/* ------------------------------------------------------------------ */

describe("CLI", () => {
  it("--version prints 0.1.0 and exits 0", () => {
    const res = runCli(["--version"]);
    assert.equal(res.status, 0);
    assert.equal(res.stdout.trim(), "0.1.0");
    assert.equal(res.stdout.trim(), VERSION);
  });

  it("-v prints 0.1.0 and exits 0", () => {
    const res = runCli(["-v"]);
    assert.equal(res.status, 0);
    assert.equal(res.stdout.trim(), "0.1.0");
  });

  it("an unknown command prints usage on stderr and exits 2", () => {
    const res = runCli(["not-a-tool"]);
    assert.equal(res.status, 2);
    assert.match(res.stderr, /Usage:/);
    assert.match(
      res.stderr,
      /generate_landing_page, get_service_info, list_paid_apis/,
    );
  });

  it("no command at all prints usage on stderr and exits 2", () => {
    const res = runCli([]);
    assert.equal(res.status, 2);
    assert.match(res.stderr, /Usage:/);
  });

  it("a non-JSON argument exits 2", () => {
    const res = runCli([GENERATE, "not json"]);
    assert.equal(res.status, 2);
  });

  it("a JSON array argument exits 2", () => {
    const res = runCli([GENERATE, "[]"]);
    assert.equal(res.status, 2);
  });

  it("extra arguments after a tool exit 2", () => {
    const res = runCli([GENERATE, "{}", "extra"]);
    assert.equal(res.status, 2);
  });

  it("extra arguments after mcp exit 2", () => {
    const res = runCli(["mcp", "extra"]);
    assert.equal(res.status, 2);
  });
});
