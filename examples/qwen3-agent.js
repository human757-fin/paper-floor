/* ============================================================================
 * Paper Floor — Qwen3 8B example agent (local Ollama)
 * ============================================================================
 * A self-contained example trading agent that decides and executes trades
 * through the Paper Floor API (window.paperfloor) using a LOCAL Ollama model.
 *
* Requirements
 *   - Ollama running locally (default http://localhost:11434)
 *   - Model tag: qwen3:8b-Q4_K_M   (check with: ollama list)
 *   - Page opened over http (not file://). For GitHub Pages / custom domains,
 *     Chrome's Private Network Access blocks the direct browser->localhost call
 *     even with CORS allowlisted, so run the bundled proxy and the agent will
 *     fall back to it automatically:
 *         node examples/ollama-proxy.js     (listens on http://localhost:8765)
 *     (You can also allowlist the origin in Ollama instead when serving the app
 *     over a local http:// origin:
 *         setx OLLAMA_ORIGINS "https://human757-fin.github.io"   # then restart Ollama)
 *
 * Loading
 *   Option A (recommended): deploy this file with the app (it already lives in
 *   examples/) and uncomment the script tag under the app script in index.html,
 *   or just load it from the DevTools console:
 *       <script src="examples/qwen3-agent.js" defer></script>
 *   Option B: paste this file's contents into the browser DevTools console.
 *
 * Starting / stopping (from the page console):
 *       window.qwenAgent.start()
 *       window.qwenAgent.stop()
 *       window.qwenAgent.runOnce()      // one decision now, no loop
 *       window.qwenAgent.status()
 *
 * Preload overrides (define before this file loads):
 *       window.PF_QWEN_CONFIG = { agentId: "qwen3", cash: 100000,
 *                                 intervalMs: 60000, endpoint: "..." };
 *       window.PF_QWEN_AUTOSTART = true;   // start the loop on page load
 * ==========================================================================*/
(function () {
  "use strict";

  var CONFIG = {
    model: "qwen3:8b-Q4_K_M",
    endpoint: "http://localhost:11434/api/chat",
    agentId: "qwen3",
    agentName: "Qwen3 8B",
    cash: 50000,
    owner: "user",
    intervalMs: 10000,
    numPredict: 220,
    temperature: 0.2,
    historyDepth: 8,
    maxTradeQty: 25,
    maxAllocationPct: 0.25,
    holdIfCashBelow: 100,
  };

  // merge any preload overrides
  var pre = window.PF_QWEN_CONFIG || {};
  Object.keys(pre).forEach(function (k) { CONFIG[k] = pre[k]; });

  var ticking = false;     // guard against overlapping runs
  var handle = null;       // setInterval handle
  var logs = [];           // ring buffer of the last ~40 log lines
  var last = null;         // last decision outcome
  var startedAt = null;

  function log(kind, msg) {
    var line = {
      t: Date.now(),
      kind: kind, // "info" | "ok" | "warn" | "err"
      msg: String(msg),
    };
    logs.push(line);
    if (logs.length > 40) logs.shift();
    var style =
      kind === "ok" ? "color:#2ecc71" :
      kind === "warn" ? "color:#f1c40f" :
      kind === "err" ? "color:#e74c3c" : "color:#7c8792";
    console.log("%c[Qwen3-agent] " + line.msg, style);
  }

  function badge(text) {
    try {
      if (!document.body) return;
      var b = document.getElementById("pf-qwen-badge");
      if (!b) {
        b = document.createElement("div");
        b.id = "pf-qwen-badge";
        b.style.cssText =
          "position:fixed;right:12px;bottom:12px;z-index:99999;max-width:340px;" +
          "font:12px/1.4 'IBM Plex Mono',Consolas,monospace;background:#10161c;" +
          "border:1px solid #2ecc71;border-radius:8px;color:#e7e9ea;padding:8px 10px;" +
          "box-shadow:0 2px 12px rgba(0,0,0,.4);white-space:pre-wrap";
        document.body.appendChild(b);
      }
      b.style.borderColor = text.indexOf("warn") >= 0 ? "#f1c40f" : text.indexOf("err") >= 0 ? "#e74c3c" : "#2ecc71";
      b.textContent = text;
    } catch (e) { /* badge is cosmetic; never break the loop */ }
  }

  function ensureAgent() {
    if (!window.paperfloor) {
      log("err", "window.paperfloor not found - run inside the Paper Floor page");
      return false;
    }
    var exists = window.paperfloor.getPortfolio({ account: CONFIG.agentId }) !== null;
    if (exists) return true;
    var res = window.paperfloor.createAgent({
      id: CONFIG.agentId,
      name: CONFIG.agentName,
      cash: CONFIG.cash,
      owner: CONFIG.owner,
    });
    if (!res || res.ok === false) {
      log("err", "could not create agent: " + (res && res.error));
      return false;
    }
    log("ok", "agent account '" + CONFIG.agentId + "' created with $" + CONFIG.cash);
    return true;
  }

  function collectContext() {
    var quotes = window.paperfloor.getQuotes();
    var pf = window.paperfloor.getPortfolio({ account: CONFIG.agentId });
    var trades = window.paperfloor
      .getTradeHistory({ account: CONFIG.agentId })
      .slice(0, CONFIG.historyDepth);
    return {
      asof: new Date().toISOString(),
      quotes: quotes.map(function (q) {
        return { sym: q.sym, name: q.name, price: Math.round(q.price * 100) / 100, change: Math.round(q.change * 100) / 100 };
      }),
      cash: pf ? pf.cash : 0,
      netWorth: pf ? pf.netWorth : 0,
      holdings: pf ? pf.holdings : [],
      recentTrades: trades,
    };
  }

  function promptFor(ctx) {
    var lines = [];
    lines.push("You are " + CONFIG.agentName + ", an autonomous paper-trading agent.");
    lines.push("Rules: pick ONE action per turn. Return ONLY a JSON object and nothing else -");
    lines.push('{"action":"buy"|"sell"|"hold","symbol":"AAPL","qty":3,"reason":"short explanation"}');
    lines.push("- qty is a positive integer; stay small (<= " + CONFIG.maxTradeQty + ").");
    lines.push(
      "- A BUY must fit your cash with a 5% buffer and use at most " +
      Math.round(CONFIG.maxAllocationPct * 100) + "% of net worth in a single trade.",
    );
    lines.push("- A SELL must not exceed the quantity you currently hold.");
    lines.push("- Remember to sell; don't just let stocks in hold stay there, but dont sell if stock is clearly good.");
    lines.push("- Only use symbols listed in the market snapshot below.");
    lines.push("- HOLD when nothing is clearly good.");
    lines.push("");
    lines.push("Market snapshot (as of " + ctx.asof + "):");
    ctx.quotes.forEach(function (q) {
      lines.push(
        q.sym + " " + q.name + " $" + q.price +
        " (" + (q.change >= 0 ? "+" : "") + q.change + "%)",
      );
    });
    lines.push("");
    lines.push("Your cash: $" + Math.round(ctx.cash * 100) / 100);
    lines.push("Your net worth: $" + Math.round(ctx.netWorth * 100) / 100);
    lines.push("Current holdings: " + (ctx.holdings.length
      ? ctx.holdings.map(function (h) { return h.qty + " " + h.sym + " @ avg $" + h.avg; }).join("; ")
      : "none"));
    if (ctx.recentTrades.length) {
      lines.push("Recent trades: " + ctx.recentTrades.map(function (t) {
        return t.side + " " + t.qty + " " + t.sym + " @ $" + t.price;
      }).join(" | "));
    } else {
      lines.push("Recent trades: none yet");
    }
    lines.push("");
    lines.push("Decide now. JSON only:");
    return lines.join("\n");
  }

  function askEndpoints() {
    var eps = [CONFIG.endpoint];
    var proxy = "http://localhost:8765/api/chat";
    if (eps.indexOf(proxy) === -1) eps.push(proxy);
    return eps;
  }

  async function askOllama(prompt) {
    var t0 = Date.now();
    var lastErr = null;
    for (var i = 0; i < askEndpoints().length; i++) {
      var ep = askEndpoints()[i];
      try {
        var res = await fetch(ep, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: CONFIG.model,
            think: false,
            stream: false,
            options: {
              num_predict: CONFIG.numPredict,
              temperature: CONFIG.temperature,
            },
            messages: [
              { role: "system", content: "You return trading decisions as strict JSON." },
              { role: "user", content: prompt },
            ],
          }),
        });
        if (!res.ok) throw new Error("Ollama HTTP " + res.status + " via " + ep);
        var data = await res.json();
        var text = (data && data.message && data.message.content) || "";
        if (!text) throw new Error("Ollama returned no content via " + ep);
        log(
          "info",
          "model via " + (ep.indexOf("8765") >= 0 ? "proxy (localhost:8765)" : "Ollama (" + CONFIG.model + ")"),
        );
        log("info", "model answered in " + Math.round((Date.now() - t0) / 100) / 10 + "s");
        return text;
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr || new Error("no Ollama endpoint reachable");
  }

  function parseDecision(text) {
    var fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
    if (fenced) text = fenced[1];
    var start = text.indexOf("{");
    var end = text.lastIndexOf("}");
    if (start < 0 || end <= start) throw new Error("no JSON object in model output");
    var d = JSON.parse(text.slice(start, end + 1));
    if (d && typeof d.action === "string") {
      d.action = d.action.toLowerCase();
      if (d.symbol) d.symbol = String(d.symbol).toUpperCase();
      if (d.qty != null) d.qty = Math.floor(Number(d.qty));
    }
    return d;
  }

  function validateAgainst(ctx, d) {
    if (d.action === "hold") return d;
    var have = {};
    ctx.quotes.forEach(function (q) { have[q.sym] = true; });
    if (!have[d.symbol]) throw new Error("model picked unknown symbol " + d.symbol);
    if (!(d.qty > 0)) throw new Error("qty must be a positive integer");
    if (d.qty > CONFIG.maxTradeQty) {
      d.qty = CONFIG.maxTradeQty;
      d.reason = (d.reason || "") + " [qty capped]";
    }
    return d;
  }

  async function runOnce() {
    var started = Date.now();
    try {
      if (!ensureAgent()) return;
      var ctx = collectContext();
      var text = await askOllama(promptFor(ctx));
      var d = parseDecision(text);
      d = validateAgainst(ctx, d);
      last = { at: started, decision: d };

      if (d.action === "hold") {
        log("info", "HOLD - " + (d.reason || "no clear setup"));
        badge("Qwen3-agent: HOLD\n" + (d.reason || ""));
        return;
      }

      var opts = { account: CONFIG.agentId, symbol: d.symbol, qty: d.qty };
      if (d.action === "sell") {
        var h = (ctx.holdings || []).filter(function (x) { return x.sym === d.symbol; })[0];
        if (!h || h.qty < d.qty) {
          log("warn", "SELL " + d.symbol + " x" + d.qty + " skipped - not held (" + (h ? h.qty : 0) + ")");
          badge("Qwen3-agent: SELL " + d.symbol + " x" + d.qty + " skipped - not held\n" + (d.reason || ""));
          return;
        }
      } else if (d.action === "buy") {
        if (ctx.cash < CONFIG.holdIfCashBelow) {
          log("warn", "BUY skipped - cash " + ctx.cash + " below " + CONFIG.holdIfCashBelow);
          return;
        }
        var quote = ctx.quotes.filter(function (x) { return x.sym === d.symbol; })[0];
        if (quote && quote.price > 0) {
          var cap = Math.floor(ctx.netWorth * CONFIG.maxAllocationPct / quote.price);
          opts.qty = Math.min(opts.qty, cap, CONFIG.maxTradeQty);
          if (opts.qty <= 0) {
            log("warn", "BUY " + d.symbol + " skipped - position would be too small");
            return;
          }
        }
      } else {
        log("err", "unrecognized action '" + d.action + "'");
        return;
      }

      var res = d.action === "buy"
        ? window.paperfloor.buy(opts)
        : window.paperfloor.sell(opts);
      last = { at: started, decision: d, result: res };
      if (res && res.ok) {
        log("ok", res.trade.side + " " + res.trade.qty + " " + res.trade.sym +
          " @ $" + res.trade.price + " - " + (d.reason || ""));
        badge("Qwen3-agent: " + res.trade.side + " " + res.trade.qty + " " + res.trade.sym +
          " @ $" + res.trade.price + "\n" + (d.reason || ""));
      } else {
        log("warn", (d.action.toUpperCase() + " " + d.symbol + " x" + d.qty + " rejected: ") +
          (res && res.error));
        badge("Qwen3-agent: " + d.action.toUpperCase() + " rejected\n" + (res && res.error));
      }
    } catch (e) {
      log("err", (e && e.message) || String(e));
      badge(
        "Qwen3-agent: error - " + ((e && e.message) || e) +
        "\nhint: run 'node examples/ollama-proxy.js' on this machine, then reload.",
      );
    }
  }

  function start() {
    if (handle) return;
    // grace period so the page finishes booting before the first decision
    setTimeout(function () {
      if (ticking) return;
      ticking = true;
      runOnce().finally(function () { ticking = false; });
    }, 1000);
    handle = setInterval(function () {
      if (ticking) return; // don't stack runs if the model is slow
      ticking = true;
      runOnce().finally(function () { ticking = false; });
    }, Math.max(CONFIG.intervalMs, 10000));
    startedAt = Date.now();
    log("info", "started (every " + CONFIG.intervalMs + "ms, model " + CONFIG.model + ")");
  }

  function stop() {
    if (handle) clearInterval(handle);
    handle = null;
    log("info", "stopped");
  }

  window.qwenAgent = {
    config: CONFIG,
    start: start,
    stop: stop,
    runOnce: function () { return runOnce(); },
    status: function () {
      return {
        running: !!handle,
        startedAt: startedAt,
        lastDecision: last,
        logs: logs.slice(),
      };
    },
  };

  if (window.PF_QWEN_AUTOSTART) start();
})();
