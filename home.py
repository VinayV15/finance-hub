"""Home value from the FHFA house price index for your metro area (public data, quarterly).
Your purchase price moves with the index; a value you type on the Mortgage page always wins."""
import csv
import io
import json
import ssl
import statistics
import urllib.request
from datetime import date, datetime, timedelta

import certifi

import db

HPI_URL = "https://www.fhfa.gov/hpi/download/quarterly_datasets/hpi_at_metro.csv"
DEFAULT_CBSA = None  # your metro's FHFA code, saved as meta "home_cbsa" (e.g. 12420 = one Texas metro)
INFLATION = 2.5  # % a year, to turn market growth into today's dollars


def _download(cbsa):
    req = urllib.request.Request(HPI_URL, headers={"User-Agent": "finance-hub/1.0"})
    ctx = ssl.create_default_context(cafile=certifi.where())  # the Mac's Python has no system certificates
    with urllib.request.urlopen(req, timeout=30, context=ctx) as r:
        text = r.read().decode("utf-8", "replace")
    name, series = None, []
    for row in csv.reader(io.StringIO(text)):
        if len(row) < 5 or row[1].strip() != cbsa:
            continue
        try:
            series.append([int(row[2]), int(row[3]), float(row[4])])
            name = row[0]
        except ValueError:
            continue  # early quarters are "-"
    if not series:
        raise ValueError(f"No index rows for area {cbsa}")
    return {"cbsa": cbsa, "name": name, "series": series, "fetched": datetime.now().isoformat(timespec="seconds")}


def index(refresh=False):
    """The cached index, re-downloaded when older than 30 days (or on request). Falls back to the cache."""
    cbsa = db.get_meta("home_cbsa") or DEFAULT_CBSA
    if not cbsa:
        return None
    cached = db.get_json("hpi")
    stale = not cached or cached.get("cbsa") != cbsa or \
        datetime.now() - datetime.fromisoformat(cached["fetched"]) > timedelta(days=30)
    failed = db.get_meta("hpi_failed_at")
    backoff = failed and datetime.now() - datetime.fromisoformat(failed) < timedelta(hours=6)
    if refresh or (stale and not backoff):
        try:
            cached = _download(cbsa)
            db.set_meta("hpi", json.dumps(cached))
        except Exception as e:  # offline or FHFA down: keep the cache, try again in 6 hours
            print(f"[home] index download failed: {e}")
            db.set_meta("hpi_failed_at", datetime.now().isoformat(timespec="seconds"))
            if not cached or cached.get("cbsa") != cbsa:
                return None
    return cached


def _quarter(d):
    return d.year, (d.month - 1) // 3 + 1


def _idx_at(series, yq):
    """Index for a quarter; the latest one before it if that quarter isn't published yet."""
    best = None
    for y, q, v in series:
        if (y, q) <= yq:
            best = v
    return best


def _cagr(a, b, years):
    return ((b / a) ** (1 / years) - 1) * 100 if a and b and years > 0 else None


def growth_stats(series):
    """Long-run growth of the area, nominal and after inflation, plus a typical low/high 10-year pace."""
    by = {(y, q): v for y, q, v in series}
    last = series[-1]
    out = {"latest_quarter": f"{last[0]} Q{last[1]}"}
    for yrs in (1, 5, 10, 20, 30):
        prev = by.get((last[0] - yrs, last[1]))
        out[f"cagr_{yrs}y"] = round(_cagr(prev, last[2], yrs), 2) if prev else None
    rolling = [_cagr(by[(y - 10, q)], v, 10) for y, q, v in series if (y - 10, q) in by]
    if len(rolling) >= 8:
        qs = statistics.quantiles(rolling, n=4)
        out["low_10y"], out["high_10y"] = round(qs[0], 2), round(qs[2], 2)
    long = out.get("cagr_30y") or out.get("cagr_20y") or out.get("cagr_10y") or 3.5
    out["expected_nominal"] = round(long, 2)
    out["expected_real"] = round(long - INFLATION, 2)
    out["low_real"] = round((out.get("low_10y") or long - 2) - INFLATION, 2)
    out["high_real"] = round((out.get("high_10y") or long + 2) - INFLATION, 2)
    return out


def estimate(cfg):
    """What the home is worth: your own number if you've entered one, otherwise the purchase price moved
    with the area index since closing. Returns None without a mortgage setup."""
    if not cfg:
        return None
    base = cfg.get("original_value") or cfg.get("original_amount")
    closing = cfg.get("closing_date")
    hpi = index()
    idx_value = history = stats = None
    if hpi and base and closing:
        s = hpi["series"]
        base_idx = _idx_at(s, _quarter(date.fromisoformat(closing)))
        if base_idx:
            idx_value = round(base * s[-1][2] / base_idx, -2)
            history = [{"quarter": f"{y} Q{q}", "value": round(base * v / base_idx, -2)} for y, q, v in s if y >= date.today().year - 20]
            stats = growth_stats(s)
    manual = cfg.get("current_value")
    return {
        "value": manual or idx_value or cfg.get("appraised_value") or base,
        "source": "manual" if manual else "index" if idx_value else "appraisal" if cfg.get("appraised_value") else "purchase",
        "index_value": idx_value, "manual_value": manual, "purchase_price": base, "appraised_value": cfg.get("appraised_value"),
        "closing_date": closing, "area": hpi["name"] if hpi else None, "fetched": hpi["fetched"] if hpi else None,
        "stats": stats, "history": history,
    }
