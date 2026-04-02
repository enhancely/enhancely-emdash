# Changelog

## [0.1.0] - 2026-04-02

### Added
- Initial release of Enhancely plugin for EmDash CMS
- Automatic JSON-LD schema generation via Enhancely API on every page render
- ETag-based caching in plugin KV store (zero-cost repeated requests)
- Block Kit admin settings UI (API key, URL, enable toggle)
- Test connection button in admin
- Status route with stats (API calls, cache hits, errors, rate limits, retries)
- Retry logic with exponential backoff, jitter, and Retry-After support
- XSS-safe script tag injection with `data-source="Enhancely.ai"` attribution
- Graceful degradation: serves cached data on API errors or processing state
