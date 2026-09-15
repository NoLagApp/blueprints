# TODO

## Kraken Proxy

- [ ] **Empty filters array should not create wildcard subscription** — When a client subscribes with `filters: []`, the proxy should create a no-match subscription (receive nothing), not fall back to wildcard (`topic/#`) which receives everything. Currently the js-sdk skips sending empty filters, and the proxy treats a subscribe without filters as wildcard. Workaround: subscribe with `['__none__']` placeholder filter.
  - Files: `kraken-proxy/proxy/src/handlers/ws_handler.erl` (subscribe handler ~line 600), `js-sdk/src/client.ts` (line 453)

## JS SDK (`@nolag/js-sdk`)

- [ ] **`setFilters` with empty array switches to wildcard** — When the last filter is removed via `removeFilters`, it calls `setFilters(topic, [])` which tells the proxy to switch to wildcard mode. This is unexpected — removing all filters should mean "receive nothing", not "receive everything". Related to the proxy issue above.
  - Files: `js-sdk/src/client.ts` (`removeFilters` method)

- [ ] **`EmitOptions.filter` doc comment is wrong about wildcard subscribers** — It claims "Subscribers without filters (wildcard) will NOT receive filtered publishes." They do: a wildcard subscribes to `topic/#`, and MQTT `#` matches `topic/alice`. This matters because the docs make filters read as an access-control mechanism when they are only routing.
  - Files: `js-sdk/src/types.ts` (line ~245), vs `kraken/src/handlers/kraken_ws_handler.erl` (subscribe handler, wildcard branch)

- [ ] **`RoomContext` filter methods are typed narrower than they behave** — `setFilters`/`addFilters`/`removeFilters` are declared as `filters: string[]`, but the implementation and the wire protocol both accept AND groups (`(string | string[])[]`), as `SubscribeOptions.filters` already does. Every blueprint SDK casts at this boundary; widening the interface would remove all of those casts.
  - Files: `js-sdk/src/types.ts` (`RoomContext`), `js-sdk/src/client.ts` (line ~1599)

## Blueprint SDKs

- [ ] **Dash SDK `__none__` placeholder is a workaround** — `DashboardPanel._subscribe()` uses `['__none__']` as a placeholder filter when subscribing with empty filters to avoid wildcard. Remove this once the proxy/sdk handle empty filters properly.
  - Files: `js/dash/src/DashboardPanel.ts`
  - Note: this is now the only place in the blueprint SDKs where an empty filter array does not mean "everything". The uniform `setFilters([])` passes empty through as a wildcard in all 12 SDKs, dash included; only the legacy `joinPanel({ metricFilters: [] })` path still substitutes the placeholder, so existing panels do not start flooding.

- [ ] **Agents capability matching is client-side under load balancing** — `Handoff.onTask(capabilities, handler)` discards non-matching tasks after delivery. With `loadBalance` on, a task can be handed to a worker that cannot run it and is then silently dropped. Server-side filters fix this (`room.setFilters(capabilities, { topic: 'tasks' })` + `publishTask(env, { filter: capability })`), but adopting them has to be all-or-nothing per pool: the broker treats a wildcard and a filtered subscription as separate share groups, so a mixed pool delivers each task twice. Consider making `onTask` set the subscription filters itself once that trade-off is settled.
  - Files: `js/agents/src/patterns/handoff.ts`, `python/agents/nolag_agents/patterns/handoff.py`
