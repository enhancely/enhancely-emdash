# @enhancely/emdash

![EmDash 0.1+](https://flat.badgen.net/badge/EmDash/0.1?color=689F63&label)
![Release](https://flat.badgen.net/npm/v/@enhancely/emdash?color=ae81ff&icon=npm&label)

Enhancely plugin for [EmDash CMS](https://emdashcms.com) — automatic AI-powered JSON-LD structured data for SEO.

## What it does

This plugin automatically generates and injects JSON-LD structured data into every page of your EmDash site. It uses the [Enhancely](https://www.enhancely.ai) API to analyze page content and produce rich schema markup that improves search engine understanding and AI/LLM comprehension of your content.

## Requirements

- EmDash CMS `^0.1.0`
- An [Enhancely](https://www.enhancely.ai) account with a project API key

> [!IMPORTANT]
> This plugin requires [emdash-cms/emdash#119](https://github.com/emdash-cms/emdash/pull/119) — plugin page hooks must fire for anonymous public page visitors. Until this PR is merged, the plugin will only generate JSON-LD for authenticated admin previews.

## Installation

```sh
npm install @enhancely/emdash
```

```sh
pnpm install @enhancely/emdash
```

```sh
yarn add @enhancely/emdash
```

```sh
bun add @enhancely/emdash
```

## Setup

Add the plugin to your `astro.config.mjs`:

```ts
import { defineConfig } from "astro/config";
import emdash from "emdash/astro";
import { enhancelyPlugin } from "@enhancely/emdash";

export default defineConfig({
  integrations: [
    emdash({
      plugins: [enhancelyPlugin()],
    }),
  ],
});
```

Then configure your API key in the EmDash admin panel under **Plugins > Enhancely Settings**.

## How it works

1. On every page render, the plugin's `page:fragments` hook fires
2. It checks the KV cache for an existing ETag + JSON-LD for the page URL
3. Calls the Enhancely API with `If-None-Match` for conditional requests
4. On `200`: caches the new JSON-LD and injects a `<script type="application/ld+json">` tag into `<head>`
5. On `412`/`304`: serves the cached JSON-LD (zero API cost)
6. On `201`/`202`: page is queued for generation — serves cached data if available, or injects nothing on first visit
7. On error: gracefully degrades to cached data

The injected script tag includes `data-source="Enhancely.ai"` for identification and the full JSON-LD response including the `x-generator` field.

> [!TIP]
> We strongly recommend letting the ETag cache warm up. After the first visit triggers generation, subsequent requests are served from cache at zero API cost.

## Capabilities

| Capability | Purpose |
|-----------|---------|
| `network:fetch` | Calls Enhancely API (host-restricted to `*.enhancely.ai`) |
| `page:inject` | Injects JSON-LD via `page:fragments` hook |

## Configuration

All settings are managed via the EmDash admin UI:

| Setting | Description |
|---------|-------------|
| **API Key** | Your Enhancely project API key (`sk-...`) |
| **API URL** | API endpoint (default: `https://app.enhancely.ai/api/v1`) |
| **Enabled** | Toggle JSON-LD generation on/off |

## Paid Account

Get an account at [enhancely.ai](https://www.enhancely.ai) to get your own API key for the targeted domain.

1. Sign up at [enhancely.ai](https://www.enhancely.ai)
2. Choose a plan at [enhancely.ai/pricing](https://www.enhancely.ai/pricing)
3. Create an organization and project
4. Register your domain
5. Copy the project API key from your dashboard

## Common Questions

### What about existing and/or duplicate JSON-LDs?

They can co-exist and will be [evaluated and merged](https://www.ilanadavis.com/blogs/articles/the-myth-of-duplicate-structured-data) by the processing crawlers, like Google.

## Disclaimer

This software is provided "as is" with no guarantee. Use it at your own risk and always test it yourself before using it in a production environment. If you find any issues, please [create a new issue](https://github.com/enhancely/enhancely-emdash/issues/new).

## License

[MIT](https://opensource.org/licenses/MIT)
