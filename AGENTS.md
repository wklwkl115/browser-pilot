# Browser Pilot

Browser Pilot connects AI agents to real Chrome or Edge tabs through a Manifest V3 extension, a local Node daemon, and the `browser_*` MCP tools.

- Node 22+, ESM, strict TypeScript.
- Edit source under `src/` and `capture-src/`; never edit `dist/` or `bridge/browser_pilot_bridge/`.
- Node-emitted imports use `.js`; extension bundle imports stay extensionless.
- `src/commands/commandCatalog.ts` owns the public tool list.
- `src/kernels/*` stays pure: no browser, bridge, command, or npm runtime dependencies.
- Page actions use `browser_execute` or `browser_command`; there are no click/type tools.
- Prefer the smallest change that follows nearby code.
- Run `mise run test` or `mise run smoke-browser` only when the change needs that diagnostic.
