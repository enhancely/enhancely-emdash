/**
 * Enhancely Plugin for EmDash CMS
 *
 * Automatically generates and injects AI-powered JSON-LD structured data
 * into every page for improved SEO and AI/LLM comprehension.
 *
 * Features:
 * - Automatic JSON-LD generation via Enhancely API
 * - ETag-based caching in plugin KV store (zero redundant API calls)
 * - Configurable via admin settings UI (Block Kit)
 * - Works in both trusted and sandboxed modes
 * - Graceful degradation on API errors (serves cached data)
 *
 * Capabilities:
 * - network:fetch — calls Enhancely API (host-restricted to enhancely.ai)
 * - page:inject — contributes JSON-LD via page:metadata hook
 */

import type { PluginDescriptor } from "emdash";

export interface EnhancelyPluginOptions {
	/** API base URL — only change if instructed by Enhancely support */
	apiUrl?: string;
}

/**
 * Create the Enhancely plugin descriptor.
 *
 * Usage in astro.config.mjs:
 * ```ts
 * import emdash from "emdash/astro";
 * import { enhancelyPlugin } from "@enhancely/emdash";
 *
 * export default defineConfig({
 *   integrations: [
 *     emdash({
 *       plugins: [enhancelyPlugin()],
 *     }),
 *   ],
 * });
 * ```
 */
export function enhancelyPlugin(options?: EnhancelyPluginOptions): PluginDescriptor {
	return {
		id: "enhancely",
		version: "0.1.0",
		format: "standard",
		entrypoint: "@enhancely/emdash/sandbox",
		capabilities: ["network:fetch", "page:inject"],
		allowedHosts: [
			"enhancely.ai",
			"*.enhancely.ai",
			...(options?.apiUrl ? [new URL(options.apiUrl).hostname] : []),
		],
		adminPages: [{ path: "/settings", label: "Enhancely Settings", icon: "sparkles" }],
	};
}
