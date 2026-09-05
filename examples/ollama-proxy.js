/* ============================================================================
 * Paper Floor — local Ollama proxy
 * ============================================================================
 * Tiny zero-dependency Node proxy that forwards browser requests to a local
 * Ollama server and adds the CORS + Private-Network-Access headers that make
 * it reachable from a PUBLIC origin (GitHub Pages, custom domain, ...).
 *
 * Why: a browser page served from https://human757-fin.github.io/... counts
 * as a "public" origin. Fetching http://localhost:11434 directly triggers
 * Chrome's Private Network Access block, which Ollama (0.33.x) does NOT opt
 * into (it never sends `Access-Control-Allow-Private-Network: true`), so the
 * request dies with "Failed to fetch" regardless of OLLAMA_ORIGINS.
 *
 * Run:   node examples/ollama-proxy.js        (listens on http://localhost:8765)
 *
 * The agent auto-falls-back to this proxy when direct Ollama is blocked, so if
 * you run the proxy nothing else needs to change on GitHub Pages.
 * ==========================================================================*/
"use strict";

var http = require("http");
var OLLAMA_HOST = process.env.OLLAMA_PROXY_TARGET_HOST || "127.0.0.1";
var OLLAMA_PORT = Number(process.env.OLLAMA_PROXY_TARGET_PORT || 11434);
var PORT = Number(process.env.OLLAMA_PROXY_PORT || 8765);

var ALLOW_METHODS = "GET,POST,PUT,OPTIONS";
var ALLOW_HEADERS =
  "Content-Type,Accept,X-Requested-With,Authorization,Openai-Beta";

function corsHeaders(req) {
  var origin = req.headers.origin;
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Methods": ALLOW_METHODS,
    "Access-Control-Allow-Headers": ALLOW_HEADERS,
    "Access-Control-Expose-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Access-Control-Allow-Private-Network": "true",
    "Access-Control-Allow-Credentials": "false",
    Vary: "Origin, Access-Control-Request-Headers, Access-Control-Request-Method",
  };
}

function forward(req, res) {
  var body = [];
  req.on("data", function (c) { body.push(c); });
  req.on("end", function () {
    var payload = Buffer.concat(body);
    var headers = {
      "Content-Type": req.headers["content-type"] || "application/json",
    };
    if (payload.length) headers["Content-Length"] = payload.length;
    if (req.headers.accept) headers.Accept = req.headers.accept;
    var out = http.request(
      {
        host: OLLAMA_HOST,
        port: OLLAMA_PORT,
        path: req.url,
        method: req.method,
        headers: headers,
      },
      function (up) {
        res.writeHead(up.statusCode || 502, {
          "Content-Type": up.headers["content-type"] || "application/json",
          ...corsHeaders(req),
        });
        up.pipe(res);
      },
    );
    out.on("error", function (e) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: "proxy could not reach Ollama at " + OLLAMA_HOST + ":" + OLLAMA_PORT,
          detail: e.message,
        }),
      );
    });
    if (payload.length) out.write(payload);
    out.end();
  });
}

http
  .createServer(function (req, res) {
    var origin = req.headers.origin;
    if (req.method === "OPTIONS") {
      res.writeHead(204, corsHeaders(req));
      res.end();
      return;
    }
    if (origin) {
      res.setHeader("Access-Control-Allow-Private-Network", "true");
    }
    forward(req, res);
  })
  .listen(PORT, function () {
    console.log(
      "Ollama proxy on http://localhost:" + PORT + " -> " + OLLAMA_HOST + ":" + OLLAMA_PORT,
    );
  });