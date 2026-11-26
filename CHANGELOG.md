# Changelog

## 0.1.0 (2026-10-28)

- First release: a forwarding client for the hosted Landing en 24h MCP server. The three captured tools of the labelled subset are answered locally for tools/list, and every tools/call is forwarded upstream over a streamable-HTTP JSON-RPC session (initialize, notifications/initialized, tools/call, honouring the Mcp-Session-Id header when the upstream issues one).
- Tools: `generate_landing_page` (free single-file HTML landing page generation; only `business_name` required), `get_service_info` (published read of the done-for-you service: prices, inclusions, how to order), `list_paid_apis` (published, free-to-call catalogue read of the vendor's pay-per-call APIs). Eight captured tools are deliberately omitted — `ar_dolar`, `ar_inflacion`, `ar_feriados`, `ar_cuit`, `ar_cbu`, `ar_phone`, `fx_rate`, `web_audit` — because each is priced per call in USDC via x402 and this rebuild never originates payment.
- Upstream results pass through verbatim, including the isError flag; upstream failures surface as `draftpage error:` text results.
- One bin serves the CLI (one subcommand per tool, plus `--version`) and the stdio MCP server (`mcp` subcommand). The upstream endpoint can be overridden via `LANDINGEN24H_MCP_URL`. The registry record declares no headers on the remote, so no auth header is ever sent, and no x402 payment header is ever constructed or sent.
