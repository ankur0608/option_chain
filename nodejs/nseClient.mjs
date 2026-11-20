/**
 * Zero-dependency NSE India Option Chain client for Node.js 22+.
 * Uses built-in fetch + cookie tracking against NSE's v3 API.
 */

import dns from "node:dns";
if (typeof dns.setDefaultResultOrder === "function") {
  dns.setDefaultResultOrder("ipv4first");
}

const CANDIDATE_BASE_URLS = [
  "https://www.nseindia.in",
  "https://www.nseindia.com",
];

export const INDEX_SYMBOLS = new Set([
  "NIFTY",
  "FINNIFTY",
  "BANKNIFTY",
  "MIDCPNIFTY",
  "NIFTYNXT50",
  "NIFTYFPI",
]);

const DEFAULT_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Accept-Language": "en-US,en;q=0.9",
  "Accept-Encoding": "gzip, deflate, br",
  "sec-ch-ua": '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"macOS"',
};

function num(side, key) {
  if (!side) return null;
  const val = side[key];
  return val === undefined || val === null || val === "" ? null : val;
}

export function parsePayload(symbol, expiry, payload, expiryDates, strikeWindow = 0) {
  const records = payload?.records ?? {};
  const filtered = payload?.filtered ?? {};

  let rawRows = [];
  const getRowExpiry = (r) => r?.expiryDates ?? r?.expiryDate ?? r?.CE?.expiryDate ?? r?.PE?.expiryDate;

  if (
    filtered.data &&
    Array.isArray(filtered.data) &&
    filtered.data.length > 0
  ) {
    const firstExp = getRowExpiry(filtered.data[0]);
    if (!expiry || !firstExp || firstExp === expiry) {
      rawRows = filtered.data;
    }
  }

  if (rawRows.length === 0 && Array.isArray(records.data) && records.data.length > 0) {
    if (expiry) {
      const matched = records.data.filter((r) => {
        const exp = getRowExpiry(r);
        return !exp || exp === expiry;
      });
      rawRows = matched.length > 0 ? matched : records.data;
    } else {
      rawRows = records.data;
    }
  }

  const underlyingValue = records.underlyingValue ?? null;
  const timestamp = records.timestamp ?? "";

  let rows = [];
  for (const item of rawRows) {
    if (item.strikePrice === undefined || item.strikePrice === null) continue;
    const ce = item.CE;
    const pe = item.PE;
    const ceOi = num(ce, "openInterest");
    const peOi = num(pe, "openInterest");
    const diffOi =
      ceOi !== null || peOi !== null
        ? (peOi ?? 0) - (ceOi ?? 0)
        : null;

    rows.push({
      ce_oi: ceOi,
      ce_chng_oi: num(ce, "changeinOpenInterest"),
      ce_vol: num(ce, "totalTradedVolume"),
      ce_iv: num(ce, "impliedVolatility"),
      ce_ltp: num(ce, "lastPrice"),
      ce_chng: num(ce, "change"),
      strike: item.strikePrice,
      diff_oi: diffOi,
      pe_chng: num(pe, "change"),
      pe_ltp: num(pe, "lastPrice"),
      pe_iv: num(pe, "impliedVolatility"),
      pe_vol: num(pe, "totalTradedVolume"),
      pe_chng_oi: num(pe, "changeinOpenInterest"),
      pe_oi: peOi,
    });
  }

  rows.sort((a, b) => Number(a.strike) - Number(b.strike));

  const ceTotals = filtered.CE ?? {};
  const peTotals = filtered.PE ?? {};
  const totalCeOi = Math.trunc(
    ceTotals.totOI ?? rows.reduce((sum, r) => sum + (Number(r.ce_oi) || 0), 0)
  );
  const totalPeOi = Math.trunc(
    peTotals.totOI ?? rows.reduce((sum, r) => sum + (Number(r.pe_oi) || 0), 0)
  );
  const totalCeVol = Math.trunc(
    ceTotals.totVol ?? rows.reduce((sum, r) => sum + (Number(r.ce_vol) || 0), 0)
  );
  const totalPeVol = Math.trunc(
    peTotals.totVol ?? rows.reduce((sum, r) => sum + (Number(r.pe_vol) || 0), 0)
  );
  const pcr = totalCeOi > 0 ? Number((totalPeOi / totalCeOi).toFixed(4)) : null;

  let closestStrike = null;
  if (underlyingValue !== null && rows.length > 0) {
    let closestIdx = 0;
    let bestDiff = Infinity;
    for (let i = 0; i < rows.length; i += 1) {
      const diff = Math.abs(Number(rows[i].strike) - Number(underlyingValue));
      if (diff < bestDiff) {
        bestDiff = diff;
        closestIdx = i;
      }
    }
    closestStrike = Number(rows[closestIdx].strike);

    if (strikeWindow > 0) {
      const start = Math.max(0, closestIdx - (strikeWindow - 1));
      const end = Math.min(rows.length, closestIdx + 1 + strikeWindow);
      rows = rows.slice(start, end);
    }
  }

  return {
    symbol,
    expiry,
    timestamp,
    underlyingValue,
    closestStrike,
    strikeWindow,
    totalCeOi,
    totalPeOi,
    totalCeVol,
    totalPeVol,
    pcr,
    rows,
    expiryDates,
  };
}

export class NSEOptionChainClient {
  constructor(timeoutMs = 15000) {
    this.timeoutMs = timeoutMs;
    this.baseUrl = CANDIDATE_BASE_URLS[0];
    this.cookies = new Map();
    this.sessionReady = false;
    this.expiryCache = new Map();
  }

  _saveCookies(response) {
    const setCookies =
      typeof response.headers.getSetCookie === "function"
        ? response.headers.getSetCookie()
        : [];
    for (const raw of setCookies) {
      const pair = raw.split(";")[0];
      const eqIdx = pair.indexOf("=");
      if (eqIdx > 0) {
        const name = pair.slice(0, eqIdx).trim();
        const value = pair.slice(eqIdx + 1).trim();
        this.cookies.set(name, value);
      }
    }
  }

  _cookieHeader() {
    return Array.from(this.cookies.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");
  }

  async initSession() {
    this.cookies.clear();

    const headers = {
      ...DEFAULT_HEADERS,
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
      "Upgrade-Insecure-Requests": "1",
      "Sec-Fetch-Dest": "document",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": "none",
      "Sec-Fetch-User": "?1",
    };

    const hostsToTry = [
      this.baseUrl,
      ...CANDIDATE_BASE_URLS.filter((u) => u !== this.baseUrl),
    ];
    let lastError = null;

    for (const host of hostsToTry) {
      // 1. Try /option-chain on this host
      try {
        const res = await fetch(`${host}/option-chain`, {
          headers,
          signal: AbortSignal.timeout(this.timeoutMs),
          redirect: "follow",
        });
        this._saveCookies(res);
        await res.text().catch(() => {});
        if (this.cookies.size > 0) {
          this.baseUrl = host;
          this.sessionReady = true;
          return;
        }
      } catch (err) {
        lastError = err;
      }

      // 2. Try home page / on this host
      try {
        const homeRes = await fetch(`${host}/`, {
          headers,
          signal: AbortSignal.timeout(this.timeoutMs),
          redirect: "follow",
        });
        this._saveCookies(homeRes);
        await homeRes.text().catch(() => {});
        if (this.cookies.size > 0) {
          this.baseUrl = host;
          this.sessionReady = true;
          return;
        }
      } catch (err) {
        lastError = err;
      }
    }

    this.sessionReady = true;
    if (this.cookies.size === 0 && lastError) {
      throw new Error(`Failed to establish NSE session cookies: ${lastError.message}`);
    }
  }

  async _getJson(pathAndQuery) {
    if (!this.sessionReady || this.cookies.size === 0) {
      await this.initSession();
    }

    const url = `${this.baseUrl}${pathAndQuery}`;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const headers = {
        ...DEFAULT_HEADERS,
        Accept: "application/json, text/plain, */*",
        Referer: `${this.baseUrl}/option-chain`,
        "sec-fetch-dest": "empty",
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "same-origin",
      };
      const cookieStr = this._cookieHeader();
      if (cookieStr) {
        headers.Cookie = cookieStr;
      }

      let res;
      try {
        res = await fetch(url, {
          headers,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        this._saveCookies(res);
      } catch (err) {
        if (attempt === 0) {
          await this.initSession().catch(() => {});
          continue;
        }
        throw err;
      }

      if ((res.status === 401 || res.status === 403) && attempt === 0) {
        await res.text().catch(() => {});
        await this.initSession().catch(() => {});
        continue;
      }

      const text = await res.text();
      if (!res.ok) {
        throw new Error(`NSE API error ${res.status} for ${pathAndQuery}`);
      }

      try {
        return JSON.parse(text);
      } catch (err) {
        if (attempt === 0) {
          await this.initSession().catch(() => {});
          continue;
        }
        throw new Error(`Invalid JSON from NSE for ${pathAndQuery}: ${err.message}`);
      }
    }
    throw new Error(`Failed to fetch JSON from ${url}`);
  }

  async getContractInfo(symbol) {
    const sym = symbol.trim().toUpperCase();
    const query = new URLSearchParams({ symbol: sym }).toString();
    return this._getJson(`/api/option-chain-contract-info?${query}`);
  }

  async fetchSnapshot(symbol, expiry = null, strikeWindow = 0) {
    const sym = symbol.trim().toUpperCase();
    const isIndex = INDEX_SYMBOLS.has(sym);

    // Try primary approach: v3 API
    try {
      let expiryDates = this.expiryCache.get(sym);
      if (!expiryDates || (expiry && !expiryDates.includes(expiry))) {
        const info = await this.getContractInfo(sym);
        expiryDates = info.expiryDates ?? [];
        if (expiryDates.length > 0) {
          this.expiryCache.set(sym, expiryDates);
        }
      }

      if (expiryDates && expiryDates.length > 0) {
        const selectedExpiry = expiry || expiryDates[0];
        if (expiryDates.includes(selectedExpiry)) {
          const ocType = isIndex ? "Indices" : "Equity";
          const query = new URLSearchParams({
            type: ocType,
            symbol: sym,
            expiry: selectedExpiry,
          }).toString();

          const payload = await this._getJson(`/api/option-chain-v3?${query}`);
          return parsePayload(sym, selectedExpiry, payload, expiryDates, strikeWindow);
        }
      }
    } catch (v3Err) {
      console.warn(`[NSE] v3 API attempt failed (${v3Err.message}), trying fallback endpoint...`);
    }

    // Fallback approach: standard option-chain-indices / option-chain-equities endpoint
    const fallbackPath = isIndex
      ? `/api/option-chain-indices?symbol=${encodeURIComponent(sym)}`
      : `/api/option-chain-equities?symbol=${encodeURIComponent(sym)}`;

    const payload = await this._getJson(fallbackPath);
    const expiryDates = payload?.records?.expiryDates ?? [];
    if (!expiryDates || expiryDates.length === 0) {
      throw new Error(`No expiry dates found for symbol '${sym}'.`);
    }
    this.expiryCache.set(sym, expiryDates);

    const selectedExpiry = expiry || expiryDates[0];
    return parsePayload(sym, selectedExpiry, payload, expiryDates, strikeWindow);
  }
}
