// patterns.js - shared bounded pattern matching helpers for bridge filters.

const PI_BROWSER_NETWORK_MAX_PATTERN_CHARS = 512;
const PI_BROWSER_NETWORK_MAX_MATCH_CHARS = 8192;

function isSafeNetworkRegexPattern(pattern: unknown): boolean {
  const text = String(pattern || '');
  if (!text || text.length > PI_BROWSER_NETWORK_MAX_PATTERN_CHARS) return false;
  if (/\\(?:[1-9]|k[<'])/.test(text)) return false;
  if (/\(\?[^:]/.test(text)) return false;
  if (/\([^)]*(?:[*+]|\{\d)[^)]*\)\s*(?:[*+?]|\{\d)/.test(text)) return false;
  if (/\([^)]*\|[^)]*\)\s*(?:[*+?]|\{\d)/.test(text)) return false;
  if ((text.match(/\.\*/g) || []).length > 6) return false;
  return true;
}

function matchNetworkPattern(url: unknown, pattern: unknown): boolean {
  const haystack = String(url || '').slice(0, PI_BROWSER_NETWORK_MAX_MATCH_CHARS);
  const needle = String(pattern || '');
  if (!needle) return false;
  if (isSafeNetworkRegexPattern(needle)) {
    try { return new RegExp(needle).test(haystack); } catch (_) {}
  }
  if (needle.length > PI_BROWSER_NETWORK_MAX_PATTERN_CHARS) return false;
  return haystack.includes(needle);
}
// ESM module boundary marker for TODO 189
export { PI_BROWSER_NETWORK_MAX_PATTERN_CHARS, PI_BROWSER_NETWORK_MAX_MATCH_CHARS, isSafeNetworkRegexPattern, matchNetworkPattern };
export const __piBridgeModule_patterns = { name: "patterns", symbols: { PI_BROWSER_NETWORK_MAX_PATTERN_CHARS, PI_BROWSER_NETWORK_MAX_MATCH_CHARS, isSafeNetworkRegexPattern, matchNetworkPattern } };
