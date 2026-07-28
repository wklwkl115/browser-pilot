# Browser Pilot

Browser Pilot connects AI agents to real Chrome or Edge tabs through a Manifest V3 extension, a local Node daemon, and the `browser_*` MCP tools.

- Node 22+, ESM, strict TypeScript.
- Edit runtime source under `src/` and `capture-src/`; never edit `dist/` or `bridge/browser_pilot_bridge/`. Bridge host and port settings are owned by `bridge/browser_bridge_config.json` and synchronized with `npm run sync:config`.
- Node-emitted imports use `.js`; extension bundles follow the nearby import style.
- `src/commands/commandCatalog.ts` owns the public tool list.
- `src/kernels/*` stays pure: no browser, bridge, command, or npm runtime dependencies.
- Page actions use `browser_execute` or `browser_command`; there are no click/type tools.
- Never install all-page scripts that change page semantics or remove page security headers.
- Prefer the smallest change that follows nearby code.
- Run `mise run verify` as the canonical gate, or `mise run smoke-browser` when browser integration needs validation.
