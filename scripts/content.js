const TICKER_REGEX     = /^[A-Z]{1,5}$/;
const MAX_COMPANY_WORDS = 5;
const MAX_QUERY_LENGTH  = 60;
const DEBOUNCE_MS       = 300;

let _debounceTimer = null;

document.addEventListener('mouseup', () => {
    clearTimeout(_debounceTimer);
    _debounceTimer = setTimeout(() => {
        // Never capture text the user typed into an editable field
        const active = document.activeElement;
        if (active) {
            const tag = active.tagName;
            if (tag === 'INPUT' || tag === 'TEXTAREA') return;
            if (active.getAttribute('contenteditable') === 'true') return;
        }

        const selection = window.getSelection().toString().trim();
        if (!selection) return;

        const isTicker            = TICKER_REGEX.test(selection);
        const wordCount           = selection.split(/\s+/).length;
        const isReasonableCompany = !isTicker
            && wordCount <= MAX_COMPANY_WORDS
            && selection.length <= MAX_QUERY_LENGTH;

        if (isTicker || isReasonableCompany) {
            chrome.storage.local.set({ activeQuery: { query: selection, ts: Date.now() } });
        }
    }, DEBOUNCE_MS);
});
