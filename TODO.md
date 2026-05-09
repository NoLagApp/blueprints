# TODO

## Kraken Proxy

- [ ] **Empty filters array should not create wildcard subscription** — When a client subscribes with `filters: []`, the proxy should create a no-match subscription (receive nothing), not fall back to wildcard (`topic/#`) which receives everything. Currently the js-sdk skips sending empty filters, and the proxy treats a subscribe without filters as wildcard. Workaround: subscribe with `['__none__']` placeholder filter.
  - Files: `kraken-proxy/proxy/src/handlers/ws_handler.erl` (subscribe handler ~line 600), `js-sdk/src/client.ts` (line 453)

## JS SDK (`@nolag/js-sdk`)

- [ ] **`setFilters` with empty array switches to wildcard** — When the last filter is removed via `removeFilters`, it calls `setFilters(topic, [])` which tells the proxy to switch to wildcard mode. This is unexpected — removing all filters should mean "receive nothing", not "receive everything". Related to the proxy issue above.
  - Files: `js-sdk/src/client.ts` (`removeFilters` method)

## Blueprint SDKs

- [ ] **Dash SDK `__none__` placeholder is a workaround** — `DashboardPanel._subscribe()` uses `['__none__']` as a placeholder filter when subscribing with empty filters to avoid wildcard. Remove this once the proxy/sdk handle empty filters properly.
  - Files: `js/dash/src/DashboardPanel.ts`
