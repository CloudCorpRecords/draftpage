# BUILD REPORT — draftpage

Clean-room rebuild of `com.landingen24h/landing-en-24h` v1.3.0
(remote-only MCP server at `https://landingen24h.com/mcp`),
built 2026-10-28 as a forwarding client. Package: `@reneturcios/draftpage`
0.1.0, registry name `io.github.CloudCorpRecords/draftpage`.

## Surface built

Labelled subset: **3 of 11 captured tools built**, 8 omitted (see below).

| Tool | Required fields as served |
|------|---------------------------|
| `generate_landing_page` | `business_name` |
| `get_service_info` | *(none — no `required` key in the capture, served verbatim)* |
| `list_paid_apis` | *(none — no `required` key in the capture, served verbatim)* |

Each served tool carries exactly the keys `name`, `title`,
`description`, `inputSchema`. Every `inputSchema` is an object
schema carrying `additionalProperties: false` exactly as captured,
and none carries a `$schema` marker — none was captured, none was
invented. `generate_landing_page` carries ten properties in
captured order (`business_name`, `tagline`, `description`,
`services`, `city`, `whatsapp`, `email`, `language`, `color`,
`cta_text`) with the captured limits (e.g. `business_name`
maxLength 80, `services` an array of at most 8 strings of maxLength
200, `language` enum `["es","en"]` default `"es"`, `color` the
captured hex pattern); `get_service_info` carries one property
(`language`, enum `["en","es"]` — note the captured order differs
from the generator's — default `"en"`); `list_paid_apis` carries
empty `properties`. The tool literals were generated
programmatically from
`harness/fixtures/landingen24h-tools-original.json` by the script
at `/tmp/laneb7-draftpage-scratch/gen.py` (parse + re-serialise,
spliced into `src/forward.ts` between the TOOL_DEFS_GENERATED
markers) — never retyped — and the generator's round-trip check
confirmed the spliced block is byte-identical to the generator
output and deep-equals the fixture's 3 tool objects, in order.
Tools are registered via the MCP SDK low-level Server API
(`ListToolsRequestSchema` / `CallToolRequestSchema` handlers),
not McpServer+zod.

## Omissions — the eight x402 pay-per-call tools

- OMITTED: `ar_dolar`, `ar_inflacion`, `ar_feriados`, `ar_cuit`,
  `ar_cbu`, `ar_phone`, `fx_rate`, `web_audit` — each is priced
  per call in USDC via x402 in its own captured description
  (0.002–0.02 USDC per successful call), and this rebuild never
  originates payment, so the pay-per-call tools are omitted
  individually. No x402/payment header is ever constructed or
  sent (asserted in tests across every upstream request).
- Absence is asserted in tests at three levels for ALL eight
  tools: registry level (`TOOL_DEFS` / `TOOL_NAMES` /
  `isKnownTool`), MCP layer (an in-memory-transport `tools/list`
  response carries exactly the 3 built tools and deep-equals the
  fixture; `handleCallTool` and an MCP `tools/call` for each
  omitted tool are rejected before any network hop), and CLI
  level (`draftpage <omitted> '{}'` for each of the eight exits 2
  with usage and is not listed among the commands).
- KEPT: `list_paid_apis` — a published catalogue read (API URL,
  price, input schema, example) that is free to call per its own
  captured description and buys nothing itself; the kept surface's
  core (the server's namesake free landing-page generator, plus
  the free `get_service_info` read) is a faithful standalone
  remainder, with the paid APIs a separately catalogued sideline.

## Fixture conflicts

**None.** The spec and the fixture agree on the tools' names,
titles, descriptions, the `required` array (`business_name` for
`generate_landing_page`, none for the other two), the
`additionalProperties: false` on every schema, and the property
shapes. The fixture already excludes all eight omitted tools,
exactly as the spec's Omissions section describes. (The spec's
note that the registry record resolved at v1.3.0 while harvest-4
listed v1.2.0 is a record-version note, not a fixture conflict;
the fixture capture governs and carries no version field.)

## Labelled reconstructions (from the spec's Wire section)

- Upstream endpoint pinned: `https://landingen24h.com/mcp`.
- Env override `LANDINGEN24H_MCP_URL` — labelled reconstruction.
- The registry record declares NO headers on the remote: no auth
  header is ever sent, under any environment. Tests assert that
  no `Authorization` header (and no `X-API-Key` header) is sent
  with an empty environment, with a `LANDINGEN24H_API_KEY`-style
  variable present, and with `AUTHORIZATION` / `API_KEY` /
  `LANDINGEN24H_TOKEN` variables present; a dedicated test also
  asserts no header key containing `x402` or `payment` is sent
  even when `X402_PAYMENT` / `PAYMENT_SIGNATURE` variables are
  present in the environment.
- Error rendering `draftpage error:` text for upstream failures
  — labelled reconstruction.
- Upstream results pass through verbatim, including `isError`
  and extra fields. tools/call is forwarded as streamable-HTTP
  JSON-RPC: initialize (protocolVersion `2025-03-26`) →
  notifications/initialized → tools/call, honouring
  `Mcp-Session-Id` when issued; plain-JSON and SSE replies are
  both parsed. The forwarding core takes an injectable fetch;
  tests stub the upstream — no live network calls in tests, and
  no live call is claimed beyond the coordinator's tools/list
  capture.

## Deviations

**None.** The lockfile was generated clean on the first attempt
(Route 3, below), `tsc` and the test suite ran through the
normal npm scripts, and the parity run used the compiled
`dist/cli.js` exactly as prescribed. No write-guard workaround
was needed and no dist was produced by any other route.

## Lockfile

- Generated from birth in a clean directory (no `node_modules`,
  no pre-existing lockfile) with
  `npm install --package-lock-only --ignore-scripts --offline`
  → success.
- Verified: parses as JSON; `name` == `@reneturcios/draftpage`;
  exactly **128** package entries; sha256
  `af24419744e14133fae17d763cc777d529121e0699c70ccd43edfa4012a198dc`.
- `npm ci --ignore-scripts --offline` → success; lockfile sha256
  re-verified **unchanged** afterwards.

## server.json

- Description exactly: "Generate a free landing page as HTML, and read the service info and pay-per-call API catalogue." — **95 characters**.
- npm package entry carries `"version": "0.1.0"`; the OCI entry
  (`ghcr.io/cloudcorprecords/draftpage:0.1.0`) carries **no**
  `version` field. Both entries carry packageArguments
  `[{type: positional, value: mcp}]` and transport stdio.
  Dockerfile (node:20-alpine, both stages) carries the label
  `io.modelcontextprotocol.server.name="io.github.CloudCorpRecords/draftpage"`.
  Container workflow `IMAGE` is `ghcr.io/cloudcorprecords/draftpage`
  and its smoke test asserts the server name `draftpage`.

## Verification (run 2026-10-28, builder session)

1. `tsc --noEmit` (direct `node_modules/.bin/tsc`) → exit 0.
2. `npm run build` → exit 0; `dist/` produced for all five source
   modules.
3. `node dist/cli.js --version` → `0.1.0`.
4. `npm test` → **89 tests, 89 pass, 0 fail** (registration-integrity
   suite deep-equals the served tools/list against the fixture's 3
   tools; the omission suite asserts `ar_dolar`, `ar_inflacion`,
   `ar_feriados`, `ar_cuit`, `ar_cbu`, `ar_phone`, `fx_rate` and
   `web_audit` absent at registry, MCP-layer — tools/list and
   tools/call — and CLI level; plus session handling/reuse, env
   override, the no-Authorization-header and no-x402/payment-header
   assertions under every environment, verbatim argument forwarding
   and result pass-through including upstream isError, SSE parsing,
   error rendering, MCP-layer validation, and CLI behaviour).
5. Parity (harness, tools-file mode against
   `harness/fixtures/landingen24h-tools-original.json`, rebuild
   `stdio:node /home/hatch/workspace/mcp-rebuild-100/builds/draftpage/dist/cli.js mcp`)
   → **verdict PASS, parity 100.0** (3/3 identical, 0 missing,
   0 extra, no schema diffs). Output in `parity-out/`.
6. Full 19-file factory set present; version consistency
   (`package.json` = `server.json` top-level = npm entry = OCI tag
   = core `VERSION` = newest CHANGELOG heading, all `0.1.0`) and
   name consistency (`package.json` `mcpName` = `server.json`
   `name` = Dockerfile server-name label) verified programmatically.
