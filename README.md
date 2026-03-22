# Prowlarr Telegram Worker

Telegram bot on Cloudflare Workers to search Prowlarr and grab releases via configured download clients.

## Commands

- `/setup` (interactive URL + API key setup)
- `/setup status`
- `/setup reset`
- `/tv <query>`
- `/movies <query>`
- `/books <query>`
- `/games <query>`
- `/search <query>`

Returns results with inline `⬇️` buttons. Pressing a button triggers a Prowlarr grab.

## Setup

1. Install deps:
```bash
npm install
```

2. Create a KV namespace (for temporary search result cache):
```bash
wrangler kv namespace create SEARCH_CACHE
```
Copy the namespace id into `wrangler.toml`.

3. Configure required secret:
```bash
wrangler secret put TELEGRAM_BOT_TOKEN
```

Optional fallback (if you don't want per-user /setup config):
```bash
wrangler secret put PROWLARR_API_KEY
```

4. Set vars in `wrangler.toml`:
- `TELEGRAM_ALLOWED_USER_IDS` (comma-separated Telegram user IDs)
- Optional fallback: `PROWLARR_URL`

5. Deploy:
```bash
npm run deploy
```

6. Set Telegram webhook:
```bash
curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook?url=https://<your-worker-domain>/telegram"
```

## Notes

- Category IDs used:
  - TV: `5000`
  - Movies: `2000`
  - Books: `7000`
  - Games: `1000`
- If your indexers use unusual categories, adjust `CATEGORY_MAP` in `src/index.ts`.
- Current grab call uses `POST /api/v1/search` with `{guid,indexerId}`. If your Prowlarr version differs, we can switch to your instance’s exact grab endpoint.
