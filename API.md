# Paper Floor API

Paper Floor exposes two surfaces for programmatic trading:

1. **In-page JavaScript API** — `window.paperfloor` in the browser console or any script running on the page.
2. **URL endpoint** — hash-routed HTTP-style calls (`index.html#/api/<action>?k=v&k=v`) usable from the address bar, links, `curl`, or headless browsers.

Both surfaces drive the same engine and persist to `localStorage`.

---

## Account model

Every account has:

| field      | type    | meaning                                                        |
|------------|---------|----------------------------------------------------------------|
| `id`       | string  | unique key                                                      |
| `name`     | string  | display name                                                    |
| `cash`     | number  | available cash                                                  |
| `initialCash` | number | cash the account was seeded with (used by `resetAccount`)     |
| `holdings` | object  | `{ SYMBOL: { qty, avg } }`                                      |
| `trades`   | array   | trade history                                                    |
| `color`    | string  | hex color, auto-assigned from the palette                        |
| `status`   | string  | `"enabled"` or `"disabled"` (disabled accounts cannot trade)     |
| `kind`     | string  | `"human"` or `"agent"`                                           |
| `owner`    | string  | account id of the human account an account belongs to            |

Ownership rules:

- **Humans** own themselves (`kind` = `"human"`, `owner` = own id).
- **Agents** always link to a human account (`kind` = `"agent"`, `owner` = a human account id).
- The main user account `id === "user"` is permanent: kind `human`, owner `user`, status `"locked"` — it can never be deleted or disabled.

Defaults: `STARTING_CASH = 100000`, `MAX_ACCOUNTS = 12` (including the user).

---

## In-page API (`window.paperfloor`)

Call methods as `window.paperfloor.method({...options})`.

### Quotes & prices

| method | params | returns |
|--------------------|------------------|--------|
| `getQuotes()`      | —                | array of quote objects for every tracked symbol |
| `getPrices()`      | —                | alias of `getQuotes()` |
| `getQuote(o)`      | `o.symbol` or bare string `"AAPL"` | single quote object, or `{ ok:false, error:"Unknown symbol: AAPL" }` |

Quote object:

```json
{ "sym": "AAPL", "name": "Apple Inc.", "price": 232.15, "change": 0.29, "history": [232.15, ...] }
```

`change` is the last tick's percent change. `history` is the recent price series.

### Accounts

| method | params | returns |
|------------------------|------------------------------|--------|
| `createAccount(o)`    | `o.id` (req), `o.name`, `o.cash`, `o.status`, `o.kind` (`"human"`\|`"agent"`), `o.owner` (human account id) | `{ ok, account, error }` |
| `createAgent(o)`      | `o.id` (req), `o.name`, `o.cash`, `o.status`, `o.owner` (optional, default `"user"`) | `{ ok, account, error }` |
| `deleteAccount(o)`    | `o.account` or `o.id` | `{ ok, error }` |
| `getAccounts(o)`      | `o.owner` (optional filter) | array of account summaries |
| `getOwners()`         | — | array of human-owner summaries |
| `setAccountColor(o)`  | `o.account`, `o.color` | `boolean` |
| `setAccountStatus(o)` | `o.account`, `o.status` (`"enabled"`\|`"disabled"`) | `boolean`, `false` if unknown or the `user` account |
| `setActiveAccount(o)` | `o.account` | `boolean` |
| `resetAccount(o)`     | `o.account` | `{ ok, error }` — restores cash and empties holdings/trades |

Account summary (from `getAccounts`):

```json
{
  "id": "alpha", "name": "Alpha", "cash": 4042.8, "color": "#4DD8C8",
  "status": "enabled", "kind": "agent", "owner": "user", "ownerName": "Trader",
  "netWorth": 5000, "holdingsCount": 1, "tradesCount": 1
}
```

Owner summary (from `getOwners`):

```json
{
  "id": "user", "name": "Trader", "color": "#FFB63D",
  "agents": 1, "netWorth": 100000, "combinedNetWorth": 105000
}
```

`netWorth` = the owner account alone; `combinedNetWorth` = owner + all their agents.

### Trading & portfolio

Trade methods default to the *active account* when `account` is omitted, and reject
disabled accounts.

| method | params | returns |
|--------------------|------------------------------|--------|
| `buy(o)`  | `o.symbol`, `o.qty` (integer > 0), `o.account` (optional) | `{ ok, trade, error }` |
| `sell(o)` | `o.symbol`, `o.qty` (integer > 0), `o.account` (optional) | `{ ok, trade, error }` |
| `getPortfolio(o)`   | `o.account` (optional) | portfolio object, or `null` if the account is unknown |
| `getNetWorth(o)`    | `o.account` (optional) | number, or `null` |
| `getTradeHistory(o)` | `o.account` (optional) | trade array, newest first |

Trade object (filled back into `account.trades`):

```json
{ "time": 1788602099564, "sym": "NVDA", "side": "BUY", "qty": 4, "price": 184.3, "realizedPnl": 12.4 }
```

`realizedPnl` is only present on `SELL` trades.

Portfolio object:

```json
{
  "account": "user", "cash": 95000, "netWorth": 95500,
  "openValue": 500, "unrealized": -12, "realized": 40,
  "holdings": [
    { "sym": "NVDA", "name": "NVIDIA Corp.", "qty": 4, "avg": 180.5,
      "price": 184.3, "value": 737.2, "pl": 15.2, "plPct": 0.021 }
  ]
}
```

### Meta & events

| method | params | returns |
|------------|----------------------|--------|
| `version`  | property, not a call | `"1.1.0"` |
| `on(event, cb)` | event name, callback | unsubscribe handle |
| `off(event, cb)` | event name, callback | — |

Events:

| event | payload |
|-----------|-----------|
| `trade:executed` | `{ account, trade, accountObj }` |
| `price:ticked`   | array of quote objects |
| `account:created` | `{ id, account }` |
| `account:deleted` | `{ id }` |
| `api:call`       | `{ action, params, result }` |

---

## URL endpoint

Format:

```
index.html#/api/<action>?key=value&key=value
```

The action is dispatched to `window.paperfloor[action]` with the query params as one
options object. The hash is cleared after handling, so refreshing the page will not
re-fire the request.

### Response shaping

The endpoint wraps a result so every response is valid JSON:

- If the method returns an object containing an `ok` field, it is returned **as-is**.
- Any other return value becomes `{ "ok": true, "action": "<action>", "result": <value> }`.
- Non-callable properties (like `version`) are returned the same way.
- Unknown actions and thrown errors produce `{ "ok": false, "action": "...", "error": "..." }`.

Examples:

```
{ "ok": true, "action": "buy", "trade": { "time": 1788602099564, "sym": "MSFT", "side": "BUY", "qty": 2, "price": 478.6 }, "error": null }

{ "ok": true, "action": "getNetWorth", "result": 100000 }

{ "ok": false, "action": "nope", "error": "Unknown action: nope" }
```

### Param coercion

Query values arrive as strings and are coerced as follows:

| input | result |
|--------|--------|
| `true`, `1`, `yes` | boolean `true` |
| `false`, `0`, `no`, (empty) | boolean `false` |
| `qty`, `cash`, `share`, `limit` | number when numeric, otherwise the string |
| everything else | string, unchanged |

`raw`, `qty`, `cash`, `share`, `limit`, and any boolean-looking value are treated
specially; account ids and symbols stay strings.

### `raw=1`

By default the response renders into the on-page overlay (`#apiOverlay`, auto-hides
after 5 s). Adding `&raw=1` replaces the entire page body with the raw JSON text and
pauses the price-loop UI re-renders, so headless fetch/scrape tools get clean output:

```
curl "https://YOURNAME.github.io/repo/index.html#/api/getQuotes?raw=1"
```

`raw` accepts the same truthy values as other boolean params. The last response is
always also stored on `window.__pfLastResponse` regardless of `raw`.

### Examples

```
# quotes, version
index.html#/api/getQuotes?raw=1
index.html#/api/version?raw=1

# create an agent owned by the main human account
index.html#/api/createAgent?id=alpha&owner=user&cash=10000&name=Alpha&raw=1

# trade as that agent
index.html#/api/buy?account=alpha&symbol=MSFT&qty=2&raw=1
index.html#/api/sell?account=alpha&symbol=MSFT&qty=1&raw=1

# inspect
index.html#/api/getAccounts?owner=user&raw=1
index.html#/api/getOwners?raw=1
index.html#/api/getPortfolio?account=alpha&raw=1
index.html#/api/getNetWorth?account=alpha&raw=1
index.html#/api/getTradeHistory?account=alpha&raw=1
index.html#/api/getQuote?symbol=AAPL&raw=1
```

---

## Example agent: Qwen3 8B via local Ollama

`examples/qwen3-agent.js` is a self-contained agent that decides and executes
trades through `window.paperfloor`, running on a **local** Ollama model
(`qwen3:8b-Q4_K_M`). No API keys, no cloud.

Setup:

```bash
ollama list                     # confirm qwen3:8b-Q4_K_M is present
```

Because the agent lives in your **browser**, "localhost" is the machine that
runs the browser — the page can be hosted anywhere (GitHub Pages, a custom
domain, a local server). Two things gate a browser page reaching your local
Ollama:

1. **Private Network Access (Chrome)** — a page served from a *public* origin
   (`https://human757-fin.github.io/...`) fetching `http://localhost` is
   blocked unless the local server answers the preflight with
   `Access-Control-Allow-Private-Network: true`. Ollama 0.33.x does not send
   that header, so even with CORS allowlisted, the direct call dies with
   "Failed to fetch".
2. **CORS** — Ollama only accepts browser requests from allowed origins
   (loopback by default).

The bundled `examples/ollama-proxy.js` solves both: it's a zero-dependency
local proxy at `http://localhost:8765` that forwards to Ollama and returns the
missing headers. The agent automatically falls back to it when a direct call
fails, so the only setup needed is running it:

```powershell
node examples/ollama-proxy.js
```

(Optional, only when the app itself is served over a *local* origin like
`http://localhost:8080`: you can also skip the proxy and allowlist the origin
in Ollama instead — loopback origins work out of the box.)

(The `https:` page talking to `http://localhost` is fine — browsers exempt
loopback addresses from mixed-content blocking.)

Load the agent after the app script (or paste its contents into the console):

```html
<script src="examples/qwen3-agent.js" defer></script>
```

Then, from the page console:

```js
qwenAgent.start()               // decide + trade every ~45s
qwenAgent.stop()
qwenAgent.runOnce()             // single decision now
qwenAgent.status()              // running flag, last decision, log tail
```

Preload overrides (set before the script loads):

```js
window.PF_QWEN_CONFIG = { agentId: "qwen3", cash: 100000, intervalMs: 60000 };
window.PF_QWEN_AUTOSTART = true;   // start trading when the page loads
```

Behavior:

- Creates its agent account (`kind:"agent"`, `owner:"user"`) on first run if missing.
- Each cycle sends quotes, cash, net worth, holdings, and recent trades to the
  model and demands a strict JSON decision
  (`{"action":"buy"|"sell"|"hold","symbol":"...","qty":int,"reason":"..."}`).
- `think:false` keeps Qwen3 from emitting reasoning tokens, so output stays fast
  and clean; decisions are validated (known symbol, integer qty, trade caps)
  before execution.
- Buy size is capped at `maxAllocationPct` of net worth; sells can't exceed
  holdings. Rejected trades are logged back so the next cycle sees them.
- Final state lives on the account like any other trade; view it with
  `#/api/getTradeHistory?account=qwen3&raw=1`.

For local-origin setups the older approach also works: allowlist the page origin
in Ollama (`setx OLLAMA_ORIGINS "https://human757-fin.github.io"` then fully
restart the Ollama app) — the origin is the bare scheme+host form, never the
path. On GitHub Pages use `examples/ollama-proxy.js` instead (see above), as
Private Network Access blocks the direct call regardless of `OLLAMA_ORIGINS`.

---

## Notes & caveats

- State is stored in `localStorage` (`paperfloor_state_v2`) and survives reloads.
- Live prices require a Finnhub API key baked in at deploy time; otherwise the built-in
  simulation drives prices (a fresh tick roughly every 2.2 s).
- Accounts whose `status` is `"disabled"` (or the locked `user` account, which is always
  `"locked"` for deletion/status but can trade) reject buy/sell with
  `"Account is disabled from trading"`.