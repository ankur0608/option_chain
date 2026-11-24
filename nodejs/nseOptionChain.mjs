/**
 * Real-time NSE Option Chain server & Excel (.xlsx) exporter for Node.js 22+.
 * Serves a live SSE browser dashboard AND continuously updates an .xlsx file on disk.
 */

import dns from "node:dns";
if (typeof dns.setDefaultResultOrder === "function") {
  dns.setDefaultResultOrder("ipv4first");
}

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { NSEOptionChainClient } from "./nseClient.mjs";
import { BSEOptionChainClient, BSE_SYMBOLS } from "./bseClient.mjs";
import { fetchCandles } from "./candles.mjs";
import { buildCsvString, buildXlsxBuffer, writeCsv, writeXlsx } from "./xlsxWriter.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INDEX_HTML_PATH = path.join(__dirname, "public", "index.html");

function printHelp() {
  console.log(`Usage: node nseOptionChain.mjs [options]

Options:
  --symbol <SYM>     Index or F&O stock symbol (default: NIFTY)
  --expiry <DATE>    Expiry date DD-Mon-YYYY (default: nearest expiry)
  --interval <SEC>   Refresh interval in seconds (default: 60)
  --strikes <N>      Strikes per side around spot (5 = last 5 Calls + next 5 Puts); 0 = all (default: 5)
  --port <PORT>      Local web dashboard port (default: 3000)
  --out <PATH>       Output .xlsx path (default: option_chain_<SYMBOL>.xlsx)
  --csv              Also write matching .csv file on disk
  --once             Fetch once, write Excel file, and exit
  --no-web           Run CLI Excel sync without starting the web dashboard
  -h, --help         Show this help message
`);
}

function formatSummary(snapshot) {
  const spot = snapshot.underlyingValue;
  let atmStr = "-";
  if (spot !== null && snapshot.rows.length > 0) {
    let atm = snapshot.rows[0];
    let bestDiff = Infinity;
    for (const row of snapshot.rows) {
      const diff = Math.abs(Number(row.strike) - Number(spot));
      if (diff < bestDiff) {
        bestDiff = diff;
        atm = row;
      }
    }
    const diffSign = atm.diff_oi !== null && Number(atm.diff_oi) > 0 ? `+${atm.diff_oi}` : `${atm.diff_oi ?? "-"}`;
    atmStr = `${atm.strike} [Diff OI: ${diffSign}] (CE LTP: ${atm.ce_ltp ?? "-"}, PE LTP: ${atm.pe_ltp ?? "-"})`;
  }
  const pcrStr = snapshot.pcr !== null ? snapshot.pcr.toFixed(2) : "-";
  const nowStr = new Date().toLocaleTimeString("en-IN", { hour12: false });
  return `[${nowStr}] ${snapshot.symbol} (${snapshot.expiry}) | Spot: ${spot} | Time: ${snapshot.timestamp} | ATM: ${atmStr} | PCR: ${pcrStr} | Rows: ${snapshot.rows.length}`;
}

async function main() {
  const { values } = parseArgs({
    options: {
      symbol: { type: "string", default: "NIFTY" },
      expiry: { type: "string" },
      interval: { type: "string", default: "60" },
      strikes: { type: "string", default: "5" },
      port: { type: "string", default: "3000" },
      out: { type: "string" },
      csv: { type: "boolean", default: false },
      once: { type: "boolean", default: false },
      "no-web": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help) {
    printHelp();
    return 0;
  }

  let activeSymbol = values.symbol.trim().toUpperCase();
  let activeExpiry = values.expiry || null;
  const intervalMs = Math.max(1000, Math.round(Number(values.interval) * 1000));
  const parsedStrikes = Number.parseInt(values.strikes, 10);
  let activeStrikeWindow = Number.isNaN(parsedStrikes) ? 5 : Math.max(0, parsedStrikes);
  const port = Number.parseInt(values.port, 10) || 3000;
  const customOut = values.out ? path.resolve(values.out) : null;

  const nseClient = new NSEOptionChainClient();
  const bseClient = new BSEOptionChainClient();

  function getClientForSymbol(sym) {
    const s = sym.trim().toUpperCase();
    if (BSE_SYMBOLS.has(s)) {
      return bseClient;
    }
    return nseClient;
  }

  const sseClients = new Set();
  let latestSnapshot = null;
  let lastError = null;
  let refreshPromise = null;

  function resolveOutPath(sym) {
    return customOut ?? path.resolve(process.cwd(), `option_chain_${sym}.xlsx`);
  }

  function broadcastSnapshot(snapshot) {
    lastError = null;
    const payload = `event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`;
    for (const res of sseClients) {
      res.write(payload);
    }
  }

  function broadcastError(errMessage) {
    lastError = errMessage;
    const payload = `event: error_status\ndata: ${JSON.stringify({ error: errMessage })}\n\n`;
    for (const res of sseClients) {
      res.write(payload);
    }
  }

  async function refreshOnce() {
    if (refreshPromise) return refreshPromise;
    refreshPromise = (async () => {
      try {
        const client = getClientForSymbol(activeSymbol);
        const snapshot = await client.fetchSnapshot(
          activeSymbol,
          activeExpiry,
          activeStrikeWindow
        );
        latestSnapshot = snapshot;
        const outPath = resolveOutPath(snapshot.symbol);
        writeXlsx(snapshot, outPath);
        if (values.csv) {
          const csvPath = outPath.replace(/\.xlsx$/i, ".csv");
          writeCsv(snapshot, csvPath);
        }
        console.log(formatSummary(snapshot));
        broadcastSnapshot(snapshot);
        return snapshot;
      } finally {
        refreshPromise = null;
      }
    })();
    return refreshPromise;
  }

  if (values.once) {
    try {
      await refreshOnce();
      return 0;
    } catch (err) {
      console.error(`Fetch error: ${err.message}`);
      return 1;
    }
  }

  let server = null;
  if (!values["no-web"]) {
    const htmlBytes = fs.readFileSync(INDEX_HTML_PATH);
    server = http.createServer(async (req, res) => {
      const reqUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

      if (reqUrl.pathname === "/") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(htmlBytes);
        return;
      }

      if (reqUrl.pathname === "/events") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        res.write(": connected\n\n");
        sseClients.add(res);
        if (latestSnapshot) {
          res.write(`event: snapshot\ndata: ${JSON.stringify(latestSnapshot)}\n\n`);
        } else if (lastError) {
          res.write(`event: error_status\ndata: ${JSON.stringify({ error: lastError })}\n\n`);
        }
        req.on("close", () => sseClients.delete(res));
        return;
      }

      if (reqUrl.pathname === "/api/snapshot") {
        const reqSym = reqUrl.searchParams.get("symbol")?.trim().toUpperCase();
        const reqExp = reqUrl.searchParams.get("expiry")?.trim() || null;
        const reqStrikes = reqUrl.searchParams.get("strikes");
        if (reqSym) {
          activeSymbol = reqSym;
          activeExpiry = reqExp;
        }
        if (reqStrikes !== null && reqStrikes !== "") {
          const n = Number.parseInt(reqStrikes, 10);
          if (!Number.isNaN(n) && n >= 0) {
            activeStrikeWindow = n;
          }
        }
        try {
          const snap = await refreshOnce();
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify(snap));
        } catch (err) {
          res.writeHead(502, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ error: err.message }));
        }
        return;
      }

      if (reqUrl.pathname === "/api/candles") {
        const reqSym = reqUrl.searchParams.get("symbol")?.trim().toUpperCase() || activeSymbol;
        const interval = reqUrl.searchParams.get("interval") || "1d";
        const range = reqUrl.searchParams.get("range") || (interval === "1d" ? "1mo" : "5d");
        const currentSpot = latestSnapshot?.symbol === reqSym ? latestSnapshot.underlyingValue : null;
        try {
          const candleData = await fetchCandles(reqSym, currentSpot, range, interval);
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify(candleData));
        } catch (err) {
          res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ error: err.message }));
        }
        return;
      }

      if (reqUrl.pathname === "/download.xlsx") {
        try {
          const snap = latestSnapshot || (await refreshOnce());
          if (!snap) throw new Error("No data available yet");
          const buf = buildXlsxBuffer(snap);
          res.writeHead(200, {
            "Content-Type":
              "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "Content-Disposition": `attachment; filename="option_chain_${snap.symbol}.xlsx"`,
          });
          res.end(buf);
        } catch (err) {
          res.writeHead(503, { "Content-Type": "text/plain; charset=utf-8" });
          res.end(`Download failed: ${err.message}`);
        }
        return;
      }

      if (reqUrl.pathname === "/download.csv") {
        try {
          const snap = latestSnapshot || (await refreshOnce());
          if (!snap) throw new Error("No data available yet");
          const csvStr = buildCsvString(snap);
          res.writeHead(200, {
            "Content-Type": "text/csv; charset=utf-8",
            "Content-Disposition": `attachment; filename="option_chain_${snap.symbol}.csv"`,
          });
          res.end(csvStr);
        } catch (err) {
          res.writeHead(503, { "Content-Type": "text/plain; charset=utf-8" });
          res.end(`Download failed: ${err.message}`);
        }
        return;
      }

      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
    });

    await new Promise((resolve) => {
      server.listen(port, "127.0.0.1", () => {
        console.log(`Live Web Dashboard: http://127.0.0.1:${port}`);
        resolve();
      });
    });
  }

  console.log(
    `Starting Node.js Option Chain sync for ${activeSymbol} -> ${resolveOutPath(activeSymbol)}`
  );
  console.log(`Refreshing every ${intervalMs / 1000}s. Press Ctrl+C to stop.`);

  let stopped = false;
  let timer = null;

  const scheduleNext = async () => {
    if (stopped) return;
    const start = Date.now();
    try {
      await refreshOnce();
    } catch (err) {
      broadcastError(err.message);
      console.error(
        `[${new Date().toLocaleTimeString("en-IN", { hour12: false })}] Fetch error: ${err.message}`
      );
    }
    if (!stopped) {
      const elapsed = Date.now() - start;
      const waitMs = Math.max(500, intervalMs - elapsed);
      timer = setTimeout(scheduleNext, waitMs);
    }
  };

  process.on("SIGINT", () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    if (server) server.close();
    console.log("\nStopped by user.");
    process.exit(0);
  });

  await scheduleNext();
  return 0;
}

main().then((code) => {
  if (code !== undefined && process.argv.includes("--once")) {
    process.exit(code);
  }
});
