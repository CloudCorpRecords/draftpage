# draftpage

A small business needs a web page long before it needs a web department. draftpage is a forwarding client for the hosted Landing en 24h MCP service: it asks that service to draft a complete landing page as a single HTML file, and it can also read back what the vendor's done-for-you service includes and what its pay-per-call APIs cost. The tool list is answered on your own machine from captured definitions; each call then travels upstream and the service's answer is handed back exactly as it arrived.

Three of the service's eleven captured tools are exposed — its free core. The page generator is free, builds the page from a deterministic template and stores nothing. The other two are published reads: the done-for-you service description (prices, inclusions, how to order) and the catalogue of pay-per-call APIs. Eight captured tools are deliberately left out: `ar_dolar`, `ar_inflacion`, `ar_feriados`, `ar_cuit`, `ar_cbu`, `ar_phone`, `fx_rate` and `web_audit` are each priced per call in USDC via x402, and this rebuild never originates payment, so it registers none of them and never constructs or sends a payment header. `list_paid_apis` stays because reading the catalogue is itself free — it buys nothing.

## The tools

- **`generate_landing_page`** — A complete, responsive single-file HTML landing page for a small business: hero, services, a WhatsApp/email call to action, a contact section and a footer, with inline CSS and SEO meta tags. Only `business_name` is required; you can also pass a `tagline`, a short `description`, up to eight `services` (write `Title: short description` to give one a description), a `city`, a `whatsapp` number in international digits-only format, an `email`, the page `language` (`es` or `en`, default `es`), a brand `color` as hex, and the main button's `cta_text`. The HTML document comes back as text.
- **`get_service_info`** — What the vendor's done-for-you service is: a custom landing page written, designed and published in 24 hours, with a free draft first and payment only if the client likes it. Returns prices, what is included and how to order. Takes an optional `language` (`en` or `es`, default `en`) for the answer.
- **`list_paid_apis`** — The server's pay-per-call HTTP APIs that agents can buy with USDC via x402, each with its URL, price, input schema and an example: Argentine dolar quotes and FX rates, CUIT/CUIL and CBU/CVU validators, an Argentine phone normalizer, a web page SEO/security audit, and the landing page generator. Free to call; returns JSON text. No arguments.

## Install and run

As an MCP server via npm:

```bash
npx -y @reneturcios/draftpage mcp
```

MCP client configuration:

```json
{
  "mcpServers": {
    "draftpage": {
      "command": "npx",
      "args": ["-y", "@reneturcios/draftpage", "mcp"]
    }
  }
}
```

As a container:

```bash
docker run -i ghcr.io/cloudcorprecords/draftpage
docker run --rm ghcr.io/cloudcorprecords/draftpage generate_landing_page '{"business_name":"Acme Plumbing"}'
```

## CLI

A single binary covers both the command line and the MCP server. Every tool is a subcommand whose one argument is a JSON string of that tool's inputs:

```bash
draftpage generate_landing_page '{"business_name":"Acme Plumbing","language":"en"}'
draftpage get_service_info '{"language":"en"}'
draftpage list_paid_apis '{}'
draftpage --version
```

Exit codes: `0` for a successful forwarded call, `1` when the result that comes back is an error, and `2` for usage mistakes like an unknown subcommand or a JSON argument that does not parse. The eight omitted pay-per-call tools are not subcommands and exit `2` like any other unknown name.

## Configuration

- `LANDINGEN24H_MCP_URL` — Replaces the upstream endpoint. Defaults to the pinned hosted endpoint, `https://landingen24h.com/mcp`. (This override variable is a reconstruction introduced by this rebuild.)

The Landing en 24h registry record lists no headers for its remote, so draftpage never attaches an authentication header — every call goes upstream keyless — and it never constructs or sends an x402 payment header.

When the upstream cannot answer — it returns a JSON-RPC error, answers with a non-2xx status, sends a body that cannot be read, or the request itself fails — the caller receives an error result whose text begins with `draftpage error:`.

## How forwarding works

The first call of a process opens a session against the upstream: an `initialize` request (protocol version `2025-03-26`), a `notifications/initialized` notification, and then the `tools/call`. If the service issues an `Mcp-Session-Id` header during initialize, draftpage repeats it on subsequent requests and keeps reusing that one session until the process ends. Replies are understood in both plain JSON and server-sent-events framing. Successful results are passed through untouched, `isError` flag and any extra fields included.

## Development

```bash
npm install
npm run build   # tsc -> dist/ (dist/cli.js is the bin)
npm test        # tsx --test test/*.test.ts — stubbed upstream, no network
npm run dev     # run the CLI from source
```

The suite compares the served tool list against the captured surface tool for tool, asserts the omitted `ar_dolar`, `ar_inflacion`, `ar_feriados`, `ar_cuit`, `ar_cbu`, `ar_phone`, `fx_rate` and `web_audit` tools are absent at the registry, MCP and CLI levels, walks the session handshake and its reuse, proves no `Authorization` header and no x402/payment header is sent under any environment, and confirms that arguments travel upstream unchanged and results return unchanged.

## License

MIT — see `LICENSE`. Copyright (c) 2026 Rene Turcios.
