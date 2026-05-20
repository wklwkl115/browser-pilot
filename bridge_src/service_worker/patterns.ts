// patterns.js - shared bounded pattern matching helpers for bridge filters.

const PI_BROWSER_NETWORK_MAX_PATTERN_CHARS = 512;
const PI_BROWSER_NETWORK_MAX_MATCH_CHARS = 8192;

function isSafeNetworkRegexPattern(pattern) {
  pattern = String(pattern || '');
  if (!pattern || pattern.length > PI_BROWSER_NETWORK_MAX_PATTERN_CHARS) return false;
  if (/\\(?:[1-9]|k[<'])/.test(pattern)) return false;
  if (/\(\?[^:]/.test(pattern)) return false;
  if (/\([^)]*(?:[*+]|\{\d)[^)]*\)\s*(?:[*+?]|\{\d)/.test(pattern)) return false;
  if (/\([^)]*\|[^)]*\)\s*(?:[*+?]|\{\d)/.test(pattern)) return false;
  if ((pattern.match(/\.\*/g) || []).length > 6) return false;
  return true;
}

function matchNetworkPattern(url, pattern) {
  url = String(url || '').slice(0, PI_BROWSER_NETWORK_MAX_MATCH_CHARS);
  pattern = String(pattern || '');
  if (!pattern) return false;
  if (isSafeNetworkRegexPattern(pattern)) {
    try { return new RegExp(pattern).test(url); } catch (_) {}
  }
  if (pattern.length > PI_BROWSER_NETWORK_MAX_PATTERN_CHARS) return false;
  return url.includes(pattern);
}
// ESM module boundary marker for TODO 189
export { PI_BROWSER_NETWORK_MAX_PATTERN_CHARS, PI_BROWSER_NETWORK_MAX_MATCH_CHARS, isSafeNetworkRegexPattern, matchNetworkPattern };
export const __piBridgeModule_patterns = { name: "patterns", symbols: { PI_BROWSER_NETWORK_MAX_PATTERN_CHARS, PI_BROWSER_NETWORK_MAX_MATCH_CHARS, isSafeNetworkRegexPattern, matchNetworkPattern } };
