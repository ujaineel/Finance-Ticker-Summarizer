const YAHOO_SEARCH   = 'https://query1.finance.yahoo.com/v1/finance/search';
const YAHOO_QUOTE    = 'https://query1.finance.yahoo.com/v10/finance/quoteSummary';
const MAX_QUERY_LEN  = 100;

// ── DOM refs ──────────────────────────────────────────────────────────────────
document.getElementById('ai-date').textContent = new Date().toLocaleDateString(
    undefined, { month: 'short', day: 'numeric', year: 'numeric' }
);

const searchInput = document.getElementById('search-input');
const searchBtn   = document.getElementById('search-btn');
const statusEl    = document.getElementById('status');
const resultCard  = document.getElementById('result-card');
const hintEl      = document.getElementById('hint');

// ── Helpers ───────────────────────────────────────────────────────────────────

function setStatus(msg, isError = false) {
    statusEl.textContent = msg;
    statusEl.className   = isError ? 'error' : '';
}

function showResult(data) {
    const { price, summaryProfile, defaultKeyStatistics } = data;

    document.getElementById('res-symbol').textContent   = price?.symbol ?? '—';
    document.getElementById('res-name').textContent     = price?.longName ?? price?.shortName ?? '';
    document.getElementById('res-exchange').textContent = price?.exchangeName ?? '';

    const currentPrice = price?.regularMarketPrice?.raw;
    const change       = price?.regularMarketChange?.raw;
    const changePct    = price?.regularMarketChangePercent?.raw;
    const currency     = price?.currencySymbol ?? '$';

    document.getElementById('res-price').textContent = currentPrice != null
        ? `${currency}${currentPrice.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
        : '—';

    const changeEl = document.getElementById('res-change');
    if (change != null && changePct != null) {
        const sign = change >= 0 ? '+' : '';
        changeEl.textContent = `${sign}${change.toFixed(2)} (${sign}${(changePct * 100).toFixed(2)}%)`;
        changeEl.className   = `price-change ${change >= 0 ? 'positive' : 'negative'}`;
    } else {
        changeEl.textContent = '';
        changeEl.className   = 'price-change';
    }

    document.getElementById('res-mktcap').textContent = formatLargeNumber(price?.marketCap?.raw);
    document.getElementById('res-pe').textContent     = defaultKeyStatistics?.forwardPE?.fmt ?? '—';
    document.getElementById('res-52h-change').textContent    = defaultKeyStatistics?.['52WeekChange']?.fmt
        ?? defaultKeyStatistics?.fiftyTwoWeekHigh?.fmt ?? '—';
    document.getElementById('res-float-shares').textContent    = defaultKeyStatistics?.['floatShares']?.fmt
        ?? '—';

    const tagsEl = document.getElementById('res-tags');
    tagsEl.innerHTML = '';
    [summaryProfile?.sector, summaryProfile?.industry].filter(Boolean).forEach(tag => {
        const span = document.createElement('span');
        span.className   = 'tag';
        span.textContent = tag;
        tagsEl.appendChild(span);
    });

    document.getElementById('res-summary').textContent =
        summaryProfile?.longBusinessSummary ?? 'No description available.';

    resultCard.style.display = 'block';
    hintEl.style.display     = 'none';
    setStatus('');
}

function formatLargeNumber(value) {
    if (value == null) return '—';
    if (value >= 1e12) return `$${(value / 1e12).toFixed(2)}T`;
    if (value >= 1e9)  return `$${(value / 1e9).toFixed(2)}B`;
    if (value >= 1e6)  return `$${(value / 1e6).toFixed(2)}M`;
    return `$${value.toLocaleString()}`;
}

// ── Yahoo Finance Auth (crumb + session cookie) ───────────────────────────────

let _crumb = null;

async function getCrumb(signal) {
    if (_crumb) return _crumb;

    await fetch('https://finance.yahoo.com/', { credentials: 'include', signal });

    const resp = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', {
        credentials: 'include',
        signal,
    });
    if (!resp.ok) throw new Error(`Authentication with Yahoo Finance failed (${resp.status})`);

    _crumb = await resp.text();
    return _crumb;
}

// ── Yahoo Finance API ─────────────────────────────────────────────────────────

async function resolveSymbol(query, signal) {
    if (/^[A-Z]{1,5}$/.test(query)) return query;

    const crumb = await getCrumb(signal);
    const url   = `${YAHOO_SEARCH}?q=${encodeURIComponent(query)}&quotesCount=5&newsCount=0&enableFuzzyQuery=false&crumb=${encodeURIComponent(crumb)}`;
    const resp  = await fetch(url, { credentials: 'include', signal });
    if (!resp.ok) throw new Error(`Search request failed (${resp.status})`);

    const json   = await resp.json();
    const quotes = json.quotes ?? [];
    const hit    = quotes.find(q => q.quoteType === 'EQUITY' || q.quoteType === 'ETF');
    if (!hit) throw new Error(`No stock found for "${query}"`);

    return hit.symbol;
}

async function fetchQuote(symbol, { retried = false, signal } = {}) {
    const crumb   = await getCrumb(signal);
    const modules = 'price,summaryProfile,defaultKeyStatistics';
    const url     = `${YAHOO_QUOTE}/${encodeURIComponent(symbol)}?modules=${encodeURIComponent(modules)}&crumb=${encodeURIComponent(crumb)}`;
    const resp    = await fetch(url, { credentials: 'include', signal });

    if (resp.status === 401 && !retried) {
        _crumb = null;
        return fetchQuote(symbol, { retried: true, signal });
    }
    if (!resp.ok) throw new Error(`Data request failed (${resp.status})`);

    const json   = await resp.json();
    const result = json.quoteSummary?.result?.[0];
    console.log(result);
    if (!result) throw new Error(`No data returned for symbol "${symbol}"`);
    return result;
}

// ── Lookup orchestration ──────────────────────────────────────────────────────
// _lookupSeq guards against stale results: only the latest lookup may update the UI.
// _activeController lets us cancel in-flight network requests when a new lookup starts.

let _lookupSeq         = 0;
let _activeController  = null;

async function lookup(query) {
    const trimmed = query?.trim();

    // Input validation
    if (!trimmed) return;
    if (trimmed.length > MAX_QUERY_LEN) {
        setStatus('Query too long — please shorten your search.', true);
        return;
    }

    // Cancel any in-flight requests from the previous lookup
    if (_activeController) _activeController.abort();
    const controller  = new AbortController();
    _activeController = controller;

    const seq = ++_lookupSeq;

    setStatus(`Looking up "${trimmed}"…`);
    resultCard.style.display = 'none';

    try {
        const symbol = await resolveSymbol(trimmed, controller.signal);
        if (seq !== _lookupSeq) return; // superseded

        setStatus(`Fetching data for ${symbol}…`);
        const data = await fetchQuote(symbol, { signal: controller.signal });
        if (seq !== _lookupSeq) return; // superseded

        showResult(data);
    } catch (err) {
        if (err.name === 'AbortError') return; // cancelled by a newer lookup
        if (seq !== _lookupSeq) return;
        setStatus(err.message, true);
        console.error('[Finance Summarizer]', err);
    } finally {
        if (seq === _lookupSeq) _activeController = null;
    }
}

// ── Event listeners ───────────────────────────────────────────────────────────

searchBtn.addEventListener('click', () => lookup(searchInput.value));

searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') lookup(searchInput.value);
});

// React to text selections written by content.js
chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.activeQuery) return;

    const val = changes.activeQuery.newValue;
    // Validate shape before trusting storage data
    if (!val || typeof val !== 'object') return;
    const query = val.query;
    if (typeof query !== 'string' || !query.trim()) return;

    searchInput.value = query;
    lookup(query);
});

// On panel open, pick up any query already in storage
chrome.storage.local.get('activeQuery', ({ activeQuery }) => {
    if (!activeQuery || typeof activeQuery !== 'object') return;
    const query = activeQuery.query;
    if (typeof query !== 'string' || !query.trim()) return;

    searchInput.value = query;
    lookup(query);
});
