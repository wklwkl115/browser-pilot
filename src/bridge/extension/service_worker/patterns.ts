// patterns.js - shared bounded pattern matching helpers for bridge filters.

const BROWSER_PILOT_NETWORK_MAX_PATTERN_CHARS = 512;
const BROWSER_PILOT_NETWORK_MAX_MATCH_CHARS = 8192;

function isSafeNetworkRegexPattern(pattern: unknown): boolean {
  const text = String(pattern || '');
  if (!text || text.length > BROWSER_PILOT_NETWORK_MAX_PATTERN_CHARS) return false;
  if (/\\(?:[1-9]|k[<'])/.test(text)) return false;
  if (/\(\?[^:]/.test(text)) return false;
  if (/\([^)]*(?:[*+]|\{\d)[^)]*\)\s*(?:[*+?]|\{\d)/.test(text)) return false;
  if (/\([^)]*\|[^)]*\)\s*(?:[*+?]|\{\d)/.test(text)) return false;
  if ((text.match(/\.\*/g) || []).length > 6) return false;
  return true;
}

function matchNetworkPattern(url: unknown, pattern: unknown): boolean {
  const haystack = String(url || '').slice(0, BROWSER_PILOT_NETWORK_MAX_MATCH_CHARS);
  const needle = String(pattern || '');
  if (!needle) return false;
  if (isSafeNetworkRegexPattern(needle)) {
    try {
      return new RegExp(needle).test(haystack);
    } catch (_error) {
      /* fallback to substring match for invalid regex */
    }
  }
  if (needle.length > BROWSER_PILOT_NETWORK_MAX_PATTERN_CHARS) return false;
  return haystack.includes(needle);
}
// ESM module metadata
export { BROWSER_PILOT_NETWORK_MAX_PATTERN_CHARS, BROWSER_PILOT_NETWORK_MAX_MATCH_CHARS, isSafeNetworkRegexPattern, matchNetworkPattern };
export const __browserPilotBridgeModule_patterns = { name: "patterns", symbols: { BROWSER_PILOT_NETWORK_MAX_PATTERN_CHARS, BROWSER_PILOT_NETWORK_MAX_MATCH_CHARS, isSafeNetworkRegexPattern, matchNetworkPattern } };
