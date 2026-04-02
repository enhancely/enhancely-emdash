/**
 * Sandbox Entry Point — Enhancely
 *
 * Runs in both trusted (in-process) and sandboxed (isolate) modes.
 * Injects AI-generated JSON-LD structured data into every page via the
 * page:metadata hook.
 */

import { definePlugin } from "emdash";
import type { PluginContext, PageFragmentEvent, PageFragmentContribution } from "emdash";

// ── Constants ──

const DEFAULT_API_URL = "https://app.enhancely.ai/api/v1";
const REQUEST_TIMEOUT_MS = 8000;
const USER_AGENT = "Enhancely-EmDash/0.1.0 (+https://www.enhancely.ai)";
const MAX_RETRIES = 2;
const BASE_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 8000;
/** Total time budget for retries — must stay under hook timeout (10 000 ms) */
const RETRY_BUDGET_MS = 9000;

// ── Helpers ──

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidJsonLd(obj: unknown): obj is Record<string, unknown> {
	if (!isRecord(obj)) return false;
	return "@context" in obj && ("@graph" in obj || "@type" in obj);
}

/** Escape < and > in JSON string to prevent XSS inside <script> tags */
function safeJsonStringify(value: unknown): string {
	return JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e");
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Parse the Retry-After header into an absolute Unix timestamp (ms).
 * Supports both delta-seconds ("120") and HTTP-date ("Thu, 01 Dec 2025 16:00:00 GMT").
 */
function parseRetryAfter(header: string | null): number | null {
	if (!header) return null;
	const seconds = Number(header);
	if (!Number.isNaN(seconds) && seconds >= 0) {
		return Date.now() + seconds * 1000;
	}
	const date = Date.parse(header);
	if (!Number.isNaN(date)) {
		return date;
	}
	return null;
}

/** Exponential backoff with random jitter to decorrelate concurrent retries. */
function getBackoffMs(attempt: number): number {
	const exponential = BASE_BACKOFF_MS * 2 ** attempt;
	const jitter = Math.random() * BASE_BACKOFF_MS;
	return Math.min(exponential + jitter, MAX_BACKOFF_MS);
}

/** Returns true for transient failures worth retrying. */
function isRetryable(status: number): boolean {
	return status === 429 || status === 502 || status === 503 || status === 504 || status === 0;
}

async function getSettings(ctx: PluginContext) {
	const apiKey = await ctx.kv.get<string>("settings:apiKey");
	const apiUrl = await ctx.kv.get<string>("settings:apiUrl");
	const enabled = await ctx.kv.get<boolean>("settings:enabled");
	return {
		apiKey: apiKey ?? null,
		apiUrl: apiUrl || DEFAULT_API_URL,
		enabled: enabled !== false,
	};
}

function getFetchFn(ctx: PluginContext): FetchFn {
	if (!ctx.http) {
		throw new Error("Enhancely plugin requires network:fetch capability");
	}
	return ctx.http.fetch;
}

// ── API Client ──

interface EnhancelyApiResult {
	status: number;
	jsonLd: Record<string, unknown> | null;
	etag: string | null;
	error: string | null;
	/** Unix timestamp (ms) parsed from Retry-After header, if present */
	retryAfter: number | null;
}

async function callEnhancelyApi(
	fetchFn: FetchFn,
	apiUrl: string,
	apiKey: string,
	pageUrl: string,
	cachedEtag: string | null,
): Promise<EnhancelyApiResult> {
	const headers: Record<string, string> = {
		Authorization: `Bearer ${apiKey}`,
		"Content-Type": "application/json",
		Accept: "application/ld+json",
		"User-Agent": USER_AGENT,
	};

	if (cachedEtag) {
		headers["If-None-Match"] = cachedEtag;
	}

	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

	try {
		const response = await fetchFn(`${apiUrl.replace(/\/$/, "")}/jsonld`, {
			method: "POST",
			headers,
			body: JSON.stringify({ url: pageUrl }),
			signal: controller.signal,
		});

		clearTimeout(timeout);

		const status = response.status;
		const etag = response.headers.get("etag")?.replaceAll('"', "") ?? null;
		const retryAfter = parseRetryAfter(response.headers.get("retry-after"));

		// 412 Precondition Failed = ETag match (not modified)
		if (status === 412 || status === 304) {
			return { status, jsonLd: null, etag, error: null, retryAfter: null };
		}

		// 200 OK = JSON-LD ready
		if (status === 200) {
			const text = await response.text();
			try {
				const parsed = JSON.parse(text);
				if (isValidJsonLd(parsed)) {
					return { status, jsonLd: parsed, etag, error: null, retryAfter: null };
				}
				return { status, jsonLd: null, etag, error: "Invalid JSON-LD structure", retryAfter: null };
			} catch {
				return { status, jsonLd: null, etag, error: "Failed to parse JSON response", retryAfter: null };
			}
		}

		// 201 Created = queued, 202 Accepted = processing
		if (status === 201 || status === 202) {
			return { status, jsonLd: null, etag, error: null, retryAfter: null };
		}

		// 429 Too Many Requests
		if (status === 429) {
			return { status, jsonLd: null, etag: null, error: "Rate limited", retryAfter };
		}

		// Error responses
		let errorMsg = `HTTP ${status}`;
		try {
			const body = await response.text();
			const parsed = JSON.parse(body);
			if (isRecord(parsed) && typeof parsed.detail === "string") {
				errorMsg = parsed.detail;
			}
		} catch {
			// Ignore parse errors
		}

		return { status, jsonLd: null, etag: null, error: errorMsg, retryAfter };
	} catch (err) {
		clearTimeout(timeout);
		const msg = err instanceof Error ? err.message : "Unknown error";
		return { status: 0, jsonLd: null, etag: null, error: msg, retryAfter: null };
	}
}

// ── Cache helpers ──

interface CacheEntry {
	etag: string;
	jsonLd: Record<string, unknown>;
	updatedAt: string;
}

async function getCached(ctx: PluginContext, pageUrl: string): Promise<CacheEntry | null> {
	const key = `cache:${encodeURIComponent(pageUrl)}`;
	return ctx.kv.get<CacheEntry>(key);
}

async function setCache(
	ctx: PluginContext,
	pageUrl: string,
	etag: string,
	jsonLd: Record<string, unknown>,
): Promise<void> {
	const key = `cache:${encodeURIComponent(pageUrl)}`;
	const entry: CacheEntry = { etag, jsonLd, updatedAt: new Date().toISOString() };
	await ctx.kv.set(key, entry);
}

async function incrementStat(ctx: PluginContext, stat: string): Promise<void> {
	const current = (await ctx.kv.get<number>(`stats:${stat}`)) ?? 0;
	await ctx.kv.set(`stats:${stat}`, current + 1);
}

// ── Rate-limit state (KV-persisted across concurrent hook calls) ──

interface RateLimitState {
	/** Unix timestamp (ms) — do not send requests before this time */
	retryAfter: number;
	updatedAt: string;
}

async function getRateLimitState(ctx: PluginContext): Promise<RateLimitState | null> {
	const state = await ctx.kv.get<RateLimitState>("rateLimit:state");
	if (!state) return null;
	// Expired state — clean up
	if (Date.now() >= state.retryAfter) {
		await ctx.kv.set("rateLimit:state", null);
		return null;
	}
	return state;
}

async function setRateLimitState(ctx: PluginContext, retryAfter: number): Promise<void> {
	await ctx.kv.set("rateLimit:state", {
		retryAfter,
		updatedAt: new Date().toISOString(),
	} satisfies RateLimitState);
}

// ── Retry wrapper ──

/**
 * Wraps callEnhancelyApi with:
 * 1. Pre-flight rate-limit check (honours KV-persisted Retry-After)
 * 2. Retries on transient failures (429, 502, 503, 504, network errors)
 * 3. Exponential backoff with jitter, capped by the hook's time budget
 */
async function callWithRetry(
	fetchFn: FetchFn,
	apiUrl: string,
	apiKey: string,
	pageUrl: string,
	cachedEtag: string | null,
	ctx: PluginContext,
): Promise<EnhancelyApiResult> {
	const deadline = Date.now() + RETRY_BUDGET_MS;

	// Pre-flight: honour existing rate-limit state from a concurrent request
	const rateLimitState = await getRateLimitState(ctx);
	if (rateLimitState) {
		const waitMs = rateLimitState.retryAfter - Date.now();
		if (waitMs > deadline - Date.now()) {
			// Wait exceeds our budget — return immediately as rate-limited
			ctx.log.debug(`Rate limited for ${waitMs}ms (exceeds budget), skipping ${pageUrl}`);
			return { status: 429, jsonLd: null, etag: null, error: "Rate limited", retryAfter: rateLimitState.retryAfter };
		}
		ctx.log.debug(`Rate limited, waiting ${waitMs}ms before ${pageUrl}`);
		await sleep(waitMs);
	}

	for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
		const result = await callEnhancelyApi(fetchFn, apiUrl, apiKey, pageUrl, cachedEtag);

		if (!isRetryable(result.status)) {
			return result;
		}

		// Persist rate-limit state so concurrent hook calls respect it
		if (result.status === 429) {
			await incrementStat(ctx, "rateLimits");
			if (result.retryAfter) {
				await setRateLimitState(ctx, result.retryAfter);
			}
		}

		// Last attempt — give up
		if (attempt === MAX_RETRIES) {
			return result;
		}

		// Determine how long to wait
		const waitMs =
			result.status === 429 && result.retryAfter
				? Math.max(0, result.retryAfter - Date.now())
				: getBackoffMs(attempt);

		// Don't retry if it would blow the time budget
		if (Date.now() + waitMs > deadline) {
			ctx.log.debug(`Backoff ${waitMs}ms would exceed budget, giving up on ${pageUrl}`);
			return result;
		}

		await incrementStat(ctx, "retries");
		ctx.log.debug(`Retry ${attempt + 1}/${MAX_RETRIES} for ${pageUrl} in ${Math.round(waitMs)}ms`);
		await sleep(waitMs);
	}

	// Unreachable — for TypeScript
	return { status: 0, jsonLd: null, etag: null, error: "Max retries exceeded", retryAfter: null };
}

// ── Plugin Definition ──

export default definePlugin({
	hooks: {
		"page:fragments": {
			priority: 150,
			timeout: 10000,
			errorPolicy: "continue",
			handler: async (
				event: PageFragmentEvent,
				ctx: PluginContext,
			): Promise<PageFragmentContribution | null> => {
				const { apiKey, apiUrl, enabled } = await getSettings(ctx);

				if (!enabled || !apiKey) {
					return null;
				}

				const pageUrl = event.page.url;
				if (!pageUrl) return null;

				// Check cache for existing ETag + JSON-LD
				const cached = await getCached(ctx, pageUrl);

				// Call Enhancely API with ETag, retry logic, and rate-limit awareness
				const result = await callWithRetry(
					getFetchFn(ctx),
					apiUrl,
					apiKey,
					pageUrl,
					cached?.etag ?? null,
					ctx,
				);

				// Helper to build the script tag with Enhancely attribution
				const buildFragment = (
					jsonLd: Record<string, unknown>,
					etag: string | null,
					status: number,
				): PageFragmentContribution => ({
					kind: "html",
					placement: "head",
					key: "enhancely-jsonld",
					html: `<script type="application/ld+json" data-source="Enhancely.ai" data-status="${status}"${etag ? ` data-etag="${etag}"` : ""}>${safeJsonStringify(jsonLd)}</script>`,
				});

				// Not modified — use cached data
				if ((result.status === 412 || result.status === 304) && cached) {
					await incrementStat(ctx, "cacheHits");
					ctx.log.debug(`Cache hit for ${pageUrl}`);
					return buildFragment(cached.jsonLd, cached.etag, 200);
				}

				// Fresh JSON-LD received
				if (result.status === 200 && result.jsonLd) {
					await incrementStat(ctx, "apiHits");
					if (result.etag) {
						await setCache(ctx, pageUrl, result.etag, result.jsonLd);
					}
					ctx.log.info(`Generated JSON-LD for ${pageUrl}`);
					return buildFragment(result.jsonLd, result.etag, 200);
				}

				// Processing/queued — use cached if available
				if ((result.status === 201 || result.status === 202) && cached) {
					ctx.log.debug(`Processing, serving cached for ${pageUrl}`);
					return buildFragment(cached.jsonLd, cached.etag, 200);
				}

				// Error — graceful degradation with cached data
				if (result.error && cached) {
					await incrementStat(ctx, "errors");
					ctx.log.warn(`API error for ${pageUrl}: ${result.error}, serving cached`);
					return buildFragment(cached.jsonLd, cached.etag, 200);
				}

				if (result.error) {
					await incrementStat(ctx, "errors");
					ctx.log.warn(`API error for ${pageUrl}: ${result.error}`);
				}

				return null;
			},
		},
	},

	routes: {
		admin: {
			handler: async (
				routeCtx: { input: unknown; request: { url: string } },
				ctx: PluginContext,
			) => {
				const interaction = routeCtx.input as {
					type: string;
					page?: string;
					action_id?: string;
					value?: string;
					values?: Record<string, unknown>;
				};

				if (interaction.type === "page_load" && interaction.page === "/settings") {
					return buildSettingsPage(ctx);
				}
				if (interaction.type === "form_submit" && interaction.action_id === "save_settings") {
					return saveSettings(ctx, interaction.values ?? {});
				}
				if (interaction.type === "block_action" && interaction.action_id === "test_connection") {
					return testConnection(ctx);
				}

				return { blocks: [] };
			},
		},

		status: {
			handler: async (_routeCtx: { input: unknown; request: unknown }, ctx: PluginContext) => {
				const apiKey = await ctx.kv.get<string>("settings:apiKey");
				const enabled = await ctx.kv.get<boolean>("settings:enabled");
				const cacheHits = (await ctx.kv.get<number>("stats:cacheHits")) ?? 0;
				const apiHits = (await ctx.kv.get<number>("stats:apiHits")) ?? 0;
				const errors = (await ctx.kv.get<number>("stats:errors")) ?? 0;
				const rateLimits = (await ctx.kv.get<number>("stats:rateLimits")) ?? 0;
				const retries = (await ctx.kv.get<number>("stats:retries")) ?? 0;

				return {
					configured: !!apiKey,
					enabled: enabled !== false,
					stats: { cacheHits, apiHits, errors, rateLimits, retries },
				};
			},
		},
	},
});

// ── Block Kit Admin UI ──

async function buildSettingsPage(ctx: PluginContext) {
	const apiKey = (await ctx.kv.get<string>("settings:apiKey")) ?? "";
	const apiUrl = (await ctx.kv.get<string>("settings:apiUrl")) ?? DEFAULT_API_URL;
	const enabled = (await ctx.kv.get<boolean>("settings:enabled")) ?? true;

	return {
		blocks: [
			{ type: "header", text: "Enhancely Settings" },
			{
				type: "context",
				text: "Automatically generate AI-powered JSON-LD structured data for every page. Get your API key at https://www.enhancely.ai",
			},
			{ type: "divider" },
			{
				type: "form",
				block_id: "enhancely-settings",
				fields: [
					{
						type: "secret_input",
						action_id: "apiKey",
						label: "API Key",
						placeholder: apiKey
							? `${apiKey.slice(0, 3)}${"*".repeat(Math.min(apiKey.length - 3, 12))} — leave empty to keep current key`
							: "sk-...",
						hint: apiKey
							? `Key ${apiKey.slice(0, 7)}${"*".repeat(8)} is configured. Enter a new one to replace it.`
							: undefined,
					},
					{
						type: "text_input",
						action_id: "apiUrl",
						label: "API URL",
						initial_value: apiUrl,
						hint: "Do not change unless instructed by Enhancely support",
					},
					{
						type: "toggle",
						action_id: "enabled",
						label: "Enable JSON-LD Generation",
						initial_value: enabled,
					},
				],
				submit: { label: "Save Settings", action_id: "save_settings" },
			},
			{ type: "divider" },
			{
				type: "actions",
				elements: [
					{
						type: "button",
						label: "Test Connection",
						action_id: "test_connection",
						style: "primary",
					},
				],
			},
		],
	};
}

async function saveSettings(ctx: PluginContext, values: Record<string, unknown>) {
	if (typeof values.apiKey === "string" && values.apiKey !== "") {
		await ctx.kv.set("settings:apiKey", values.apiKey);
	}
	if (typeof values.apiUrl === "string") {
		await ctx.kv.set("settings:apiUrl", values.apiUrl);
	}
	if (typeof values.enabled === "boolean") {
		await ctx.kv.set("settings:enabled", values.enabled);
	}

	return {
		...(await buildSettingsPage(ctx)),
		toast: { message: "Settings saved", type: "success" },
	};
}

async function testConnection(ctx: PluginContext) {
	const { apiKey, apiUrl } = await getSettings(ctx);

	if (!apiKey) {
		return {
			...(await buildSettingsPage(ctx)),
			toast: { message: "Enter an API key first", type: "error" },
		};
	}

	try {
		const fetchFn = getFetchFn(ctx);
		// Use GET /jsonld?limit=1 as a lightweight auth check — validates the API key
		// without triggering generation or requiring a registered domain
		const response = await fetchFn(`${apiUrl.replace(/\/$/, "")}/jsonld?limit=1`, {
			method: "GET",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				Accept: "application/json",
				"User-Agent": USER_AGENT,
			},
		});

		if (response.ok) {
			return {
				...(await buildSettingsPage(ctx)),
				toast: { message: "Connection successful — API key is valid", type: "success" },
			};
		}

		return {
			...(await buildSettingsPage(ctx)),
			toast: { message: `API returned HTTP ${response.status}`, type: "error" },
		};
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return {
			...(await buildSettingsPage(ctx)),
			toast: { message: `Connection failed: ${msg}`, type: "error" },
		};
	}
}
