interface Env {
  TELEGRAM_BOT_TOKEN: string;
  PROWLARR_API_KEY?: string;
  PROWLARR_URL?: string;
  OVERSEERR_API_KEY?: string;
  OVERSEERR_URL?: string;
  TELEGRAM_ALLOWED_USER_IDS: string;
  SEARCH_CACHE: KVNamespace;
}

type TelegramUpdate = {
  message?: {
    chat: { id: number };
    from?: { id: number; username?: string };
    text?: string;
  };
  callback_query?: {
    id: string;
    from: { id: number };
    message?: { chat: { id: number }; message_id: number };
    data?: string;
  };
};

type ProwlarrRelease = {
  guid: string;
  title: string;
  indexerId: number;
  size?: number;
  seeders?: number;
  indexer?: string;
  publishDate?: string;
};

type SetupState = {
  step: "awaiting_url" | "awaiting_api_key";
  url?: string;
};

type OverseerrSetupState = {
  step: "awaiting_url" | "awaiting_api_key";
  url?: string;
};

type UserConfig = { url: string; apiKey: string };
type OverseerrConfig = { url: string; apiKey: string };

type OverseerrResult = {
  id: number;
  mediaType: "movie" | "tv";
  title?: string;
  name?: string;
  releaseDate?: string;
  firstAirDate?: string;
};

const CATEGORY_MAP: Record<string, number[]> = {
  tv: [5000],
  movies: [2000],
  books: [7000],
  games: [4050]
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") return json({ ok: true, service: "prowlarr-telegram-worker" });

    if (url.pathname === "/telegram" && request.method === "POST") {
      const update = (await request.json()) as TelegramUpdate;
      await handleTelegramUpdate(update, env);
      return new Response("ok");
    }

    return new Response("Not found", { status: 404 });
  }
};

async function handleTelegramUpdate(update: TelegramUpdate, env: Env) {
  const allowed = new Set(env.TELEGRAM_ALLOWED_USER_IDS.split(",").map((s) => Number(s.trim())).filter(Boolean));

  if (update.message?.text) {
    const fromId = update.message.from?.id;
    if (!fromId || !allowed.has(fromId)) return;

    const chatId = update.message.chat.id;
    const text = update.message.text.trim();

    if (text.startsWith("/start") || text.startsWith("/help")) {
      await tgSendMessage(env, chatId, [
        "🔎 Prowlarr Bot Commands:",
        "/setup",
        "/setup status",
        "/setup reset",
        "/requestsetup",
        "/requestsetup status",
        "/requestsetup reset",
        "/request <movie|tv> <query>",
        "/tv <query>",
        "/movies <query>",
        "/books <query>",
        "/games <query>",
        "/search <query>"
      ].join("\n"));
      return;
    }

    if (text.toLowerCase() === "/setup" || text.toLowerCase() === "/setup start") {
      await setSetupState(env, fromId, { step: "awaiting_url" });
      await tgSendMessage(env, chatId, "Send your Prowlarr URL (e.g. https://prowlarr.example.com)");
      return;
    }

    if (text.toLowerCase() === "/setup status") {
      const cfg = await getUserConfig(env, fromId);
      await tgSendMessage(env, chatId, cfg ? `✅ Configured: ${cfg.url}` : "⚠️ Not configured. Run /setup");
      return;
    }

    if (text.toLowerCase() === "/setup reset") {
      await clearSetupState(env, fromId);
      await clearUserConfig(env, fromId);
      await tgSendMessage(env, chatId, "✅ Setup reset. Run /setup to configure again.");
      return;
    }

    if (text.toLowerCase() === "/requestsetup" || text.toLowerCase() === "/requestsetup start") {
      await setOverseerrSetupState(env, fromId, { step: "awaiting_url" });
      await tgSendMessage(env, chatId, "Send your Overseerr URL (e.g. https://overseerr.example.com)");
      return;
    }

    if (text.toLowerCase() === "/requestsetup status") {
      const cfg = await getOverseerrConfig(env, fromId);
      await tgSendMessage(env, chatId, cfg ? `✅ Overseerr configured: ${cfg.url}` : "⚠️ Overseerr not configured. Run /requestsetup");
      return;
    }

    if (text.toLowerCase() === "/requestsetup reset") {
      await clearOverseerrSetupState(env, fromId);
      await clearOverseerrConfig(env, fromId);
      await tgSendMessage(env, chatId, "✅ Overseerr setup reset. Run /requestsetup to configure again.");
      return;
    }

    const oState = await getOverseerrSetupState(env, fromId);
    if (oState) {
      if (oState.step === "awaiting_url") {
        if (!isLikelyUrl(text)) {
          await tgSendMessage(env, chatId, "That doesn't look like a URL. Try again.");
          return;
        }
        await setOverseerrSetupState(env, fromId, { step: "awaiting_api_key", url: text });
        await tgSendMessage(env, chatId, "Great. Now send your Overseerr API key.");
        return;
      }

      if (oState.step === "awaiting_api_key" && oState.url) {
        const result = await validateOverseerrConfig(oState.url, text);
        if (!result.ok) {
          await tgSendMessage(env, chatId, `❌ Could not validate Overseerr credentials (${result.reason}). Run /requestsetup to try again.`);
          await clearOverseerrSetupState(env, fromId);
          return;
        }
        await setOverseerrConfig(env, fromId, { url: result.url, apiKey: text });
        await clearOverseerrSetupState(env, fromId);
        await tgSendMessage(env, chatId, `✅ Overseerr setup complete. Try /request movie dune`);
        return;
      }
    }

    const state = await getSetupState(env, fromId);
    if (state) {
      if (state.step === "awaiting_url") {
        if (!isLikelyUrl(text)) {
          await tgSendMessage(env, chatId, "That doesn't look like a URL. Try again.");
          return;
        }
        await setSetupState(env, fromId, { step: "awaiting_api_key", url: text });
        await tgSendMessage(env, chatId, "Great. Now send your Prowlarr API key.");
        return;
      }

      if (state.step === "awaiting_api_key" && state.url) {
        const result = await validateProwlarrConfig(state.url, text);
        if (!result.ok) {
          await tgSendMessage(env, chatId, `❌ Could not validate credentials (${result.reason}). Run /setup to try again.`);
          await clearSetupState(env, fromId);
          return;
        }
        await setUserConfig(env, fromId, { url: result.url, apiKey: text });
        await clearSetupState(env, fromId);
        const normalizedNote = result.url !== state.url ? `
(Using detected base path: ${result.url})` : "";
        await tgSendMessage(env, chatId, `✅ Setup complete. Try /movies dune${normalizedNote}`);
        return;
      }
    }

    const reqParsed = parseRequestCommand(text);
    if (reqParsed) {
      const ocfg = await resolveOverseerrConfig(env, fromId);
      if (!ocfg) {
        await tgSendMessage(env, chatId, "No Overseerr config found. Run /requestsetup first.");
        return;
      }
      const results = await overseerrSearch(ocfg, reqParsed.query, reqParsed.mediaType);
      if (!results.length) {
        await tgSendMessage(env, chatId, "No requestable results found.");
        return;
      }
      const rid = crypto.randomUUID().slice(0, 8);
      await env.SEARCH_CACHE.put(`req:${rid}`, JSON.stringify({ results: results.slice(0, 8), userId: fromId, cfg: ocfg }), { expirationTtl: 60 * 30 });
      const lines = results.slice(0,8).map((r,i)=>`${i+1}. ${overseerrTitle(r)}`);
      const kb = results.slice(0,8).map((_,i)=>[{text:`📥 Request ${i+1}`, callback_data:`req:${rid}:${i}`}]);
      await tgSendMessage(env, chatId, `Overseerr results (${reqParsed.mediaType}) for: ${reqParsed.query}\n\n${lines.join("\n")}`, { inline_keyboard: kb });
      return;
    }

    const parsed = parseCommand(text);
    if (!parsed) {
      await tgSendMessage(env, chatId, "Try /tv, /movies, /books, /games, /search, or /setup.");
      return;
    }

    const cfg = await resolveConfig(env, fromId);
    if (!cfg) {
      await tgSendMessage(env, chatId, "No Prowlarr config found. Run /setup first.");
      return;
    }

    let releases = await prowlarrSearch(cfg, parsed.query, parsed.category);
    releases = applyResultFilters(releases, parsed.category, parsed.query);
    if (!releases.length) {
      await tgSendMessage(env, chatId, "No results found.");
      return;
    }

    const cacheId = crypto.randomUUID().slice(0, 8);
    await env.SEARCH_CACHE.put(cacheId, JSON.stringify({ releases: releases.slice(0, 8), userId: fromId, cfg }), {
      expirationTtl: 60 * 30
    });

    const lines = releases.slice(0, 8).map((r, i) => {
      const sizeGb = r.size ? `${(r.size / 1024 ** 3).toFixed(2)}GB` : "?";
      const uploaded = formatUploadDate(r.publishDate);
      const infoUrl = r.infoUrl ? `\n   🔗 ${r.infoUrl}` : "";
      return `${i + 1}. ${r.title}\n   👥 ${r.seeders ?? 0} | 💾 ${sizeGb} | 🧭 ${r.indexer ?? "unknown"} | 📅 ${uploaded}${infoUrl}`;
    });

    const inline_keyboard = releases.slice(0, 8).map((_, i) => [{ text: `⬇️ ${i + 1}`, callback_data: `grab:${cacheId}:${i}` }]);
    await tgSendMessage(env, chatId, `Results for: ${parsed.query}\n\n${lines.join("\n\n")}`, { inline_keyboard });
    return;
  }

  if (update.callback_query?.data) {
    const fromId = update.callback_query.from.id;
    if (!allowed.has(fromId)) return;

    const data = update.callback_query.data;
    const chatId = update.callback_query.message?.chat.id;
    const messageId = update.callback_query.message?.message_id;
    if (!chatId) return;

    if (data.startsWith("req:")) {
      const [_, reqId, idxRaw] = data.split(":");
      const idx = Number(idxRaw);
      if (Number.isNaN(idx)) return;
      const cached = await env.SEARCH_CACHE.get(`req:${reqId}`, "json") as { results: OverseerrResult[]; userId: number; cfg: OverseerrConfig } | null;
      if (!cached || cached.userId !== fromId) {
        await tgAnswerCallback(env, update.callback_query.id, "Request session expired or unauthorized.");
        return;
      }
      const item = cached.results[idx];
      if (!item) {
        await tgAnswerCallback(env, update.callback_query.id, "Invalid selection");
        return;
      }
      await tgAnswerCallback(env, update.callback_query.id, "Submitting request...");
      const ok = await overseerrRequest(cached.cfg, item);
      await tgSendMessage(env, chatId, ok ? `✅ Requested: ${overseerrTitle(item)}` : `❌ Failed request: ${overseerrTitle(item)}`);
      return;
    }

    if (data.startsWith("grab:")) {
      const [_, cacheId, idxRaw] = data.split(":");
      const idx = Number(idxRaw);
      if (Number.isNaN(idx)) return;

      const cached = await env.SEARCH_CACHE.get(cacheId, "json") as { releases: ProwlarrRelease[]; userId: number; cfg: UserConfig; query?: string } | null;
      if (!cached || cached.userId !== fromId) {
        await tgAnswerCallback(env, update.callback_query.id, "Search expired or unauthorized.");
        return;
      }

      const selected = cached.releases[idx];
      if (!selected) {
        await tgAnswerCallback(env, update.callback_query.id, "Invalid selection");
        return;
      }

      await tgAnswerCallback(env, update.callback_query.id, "Sending to download client...");
      const ok = await prowlarrGrab(cached.cfg, selected);
      await tgSendMessage(env, chatId, ok ? `✅ Sent: ${selected.title}` : `❌ Failed to grab: ${selected.title}`);
      return;
    }

    if (data.startsWith("page:")) {
      const [_, cacheId, pageRaw] = data.split(":");
      const page = Number(pageRaw);
      if (Number.isNaN(page) || page < 0 || !messageId) return;

      const cached = await env.SEARCH_CACHE.get(cacheId, "json") as { releases: ProwlarrRelease[]; userId: number; cfg: UserConfig; query?: string } | null;
      if (!cached || cached.userId !== fromId) {
        await tgAnswerCallback(env, update.callback_query.id, "Search expired or unauthorized.");
        return;
      }

      const rendered = renderResultsPage(cached.query ?? 'search', cacheId, cached.releases, page);
      await tgEditMessage(env, chatId, messageId, rendered.text, rendered.replyMarkup);
      await tgAnswerCallback(env, update.callback_query.id, `Page ${page + 1}`);
      return;
    }
  }
}


function applyResultFilters(releases: ProwlarrRelease[], category: keyof typeof CATEGORY_MAP | undefined, query: string) {
  let out = releases;

  // Generic include/exclude tokens: +term -term
  const includeTerms = Array.from(query.matchAll(/(?:^|\s)\+([^\s]+)/g)).map(m => m[1].toLowerCase());
  const excludeTerms = Array.from(query.matchAll(/(?:^|\s)-([^\s]+)/g)).map(m => m[1].toLowerCase());

  if (includeTerms.length) {
    out = out.filter(r => {
      const t = r.title.toLowerCase();
      return includeTerms.every(term => t.includes(term));
    });
  }

  if (excludeTerms.length) {
    out = out.filter(r => {
      const t = r.title.toLowerCase();
      return excludeTerms.every(term => !t.includes(term));
    });
  }

  if (category === 'games') {
    out = filterGameResults(out, query);
  }

  return out;
}

function filterGameResults(releases: ProwlarrRelease[], query: string) {
  const q = query.toLowerCase();
  const title = (r: ProwlarrRelease) => r.title.toLowerCase();

  const wantsSwitch = /\b(switch|nintendo|nsw)\b/.test(q);
  const wantsXbox = /\b(xbox|x360|xone|series\s?[xs])\b/.test(q);
  const wantsPs = /\b(ps\d|playstation|psp|vita)\b/.test(q);
  const wantsConsole = wantsSwitch || wantsXbox || wantsPs;
  const wantsPc = /\b(pc|windows|steam|gog)\b/.test(q) || !wantsConsole;

  if (wantsSwitch) return releases.filter(r => /switch|nintendo|nsw/.test(title(r)));
  if (wantsXbox) return releases.filter(r => /xbox|x360|xone|series\s?[xs]/.test(title(r)));
  if (wantsPs) return releases.filter(r => /playstation|\bps\d\b|psp|vita/.test(title(r)));

  if (wantsPc) {
    return releases.filter(r => {
      const t = title(r);
      const pcHit = /\bpc\b|windows|steam|gog|fitgirl|repack/.test(t);
      const consoleHit = /playstation|\bps\d\b|psp|vita|xbox|x360|xone|switch|nintendo|wii|ps2/.test(t);
      return pcHit && !consoleHit;
    });
  }

  return releases;
}


function renderResultsPage(query: string, cacheId: string, releases: ProwlarrRelease[], page: number) {
  const pageSize = 5;
  const totalPages = Math.max(1, Math.ceil(releases.length / pageSize));
  const current = Math.max(0, Math.min(page, totalPages - 1));
  const start = current * pageSize;
  const items = releases.slice(start, start + pageSize);

  const lines = items.map((r, i) => {
    const absIndex = start + i;
    const sizeGb = r.size ? `${(r.size / (1024 ** 3)).toFixed(2)}GB` : "?";
    const uploaded = formatUploadDate(r.publishDate);
    const infoUrl = r.infoUrl ? `\n   🔗 ${r.infoUrl}` : "";
    return `${absIndex + 1}. ${r.title}\n   👥 ${r.seeders ?? 0} | 💾 ${sizeGb} | 🧭 ${r.indexer ?? "unknown"} | 📅 ${uploaded}${infoUrl}`;
  });

  const downloadRows = items.map((_, i) => {
    const absIndex = start + i;
    return [{ text: `⬇️ ${absIndex + 1}`, callback_data: `grab:${cacheId}:${absIndex}` }];
  });

  const navRow = [
    { text: "⬅️ Prev", callback_data: `page:${cacheId}:${Math.max(0, current - 1)}` },
    { text: `${current + 1}/${totalPages}`, callback_data: `page:${cacheId}:${current}` },
    { text: "Next ➡️", callback_data: `page:${cacheId}:${Math.min(totalPages - 1, current + 1)}` }
  ];

  return {
    text: `Results for: ${query}\n\n${lines.join("\n\n")}`,
    replyMarkup: { inline_keyboard: [...downloadRows, navRow] }
  };
}


function parseRequestCommand(text: string): { mediaType: "movie" | "tv"; query: string } | null {
  const m = text.match(/^\/request\s+(movie|tv)\s+(.+)/i);
  if (!m) return null;
  const mediaType = m[1].toLowerCase() as "movie" | "tv";
  const query = m[2].trim();
  if (!query) return null;
  return { mediaType, query };
}

function overseerrTitle(item: OverseerrResult) {
  const name = item.title || item.name || `ID ${item.id}`;
  const year = (item.releaseDate || item.firstAirDate || '').slice(0,4);
  return year ? `${name} (${year})` : name;
}

function parseCommand(text: string): { category?: keyof typeof CATEGORY_MAP; query: string } | null {
  const match = text.match(/^\/(tv|movies|books|games|search)\s+(.+)/i);
  if (!match) return null;
  const cmd = match[1].toLowerCase();
  const query = match[2].trim();
  if (!query) return null;
  return cmd === "search" ? { query } : { category: cmd as keyof typeof CATEGORY_MAP, query };
}

async function prowlarrSearch(cfg: UserConfig, query: string, category?: keyof typeof CATEGORY_MAP) {
  const params = new URLSearchParams({ query, type: "search", limit: "20", offset: "0" });
  if (category) params.set("categories", CATEGORY_MAP[category].join(","));
  const resp = await fetch(`${stripSlash(cfg.url)}/api/v1/search?${params}`, { headers: { "X-Api-Key": cfg.apiKey } });
  if (!resp.ok) return [] as ProwlarrRelease[];
  const data = (await resp.json()) as ProwlarrRelease[];
  return (data || []).sort((a, b) => (b.seeders ?? 0) - (a.seeders ?? 0));
}

async function prowlarrGrab(cfg: UserConfig, release: ProwlarrRelease) {
  const resp = await fetch(`${stripSlash(cfg.url)}/api/v1/search`, {
    method: "POST",
    headers: { "X-Api-Key": cfg.apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ guid: release.guid, indexerId: release.indexerId })
  });
  return resp.ok;
}

async function validateOverseerrConfig(inputUrl: string, apiKey: string): Promise<{ ok: boolean; url: string; reason?: string }> {
  const base = stripSlash(inputUrl);
  const candidates = [
    `${base}/api/v1/status`,
    `${base}/overseerr/api/v1/status`
  ];
  const attempts: string[] = [];
  for (const u of candidates) {
    try {
      const resp = await fetch(u, { headers: { "X-Api-Key": apiKey }, redirect: "follow" });
      attempts.push(`${new URL(u).pathname}->${resp.status}`);
      if (resp.ok) {
        const ru = new URL(resp.url);
        const normalized = ru.pathname.includes('/overseerr/') ? `${ru.origin}/overseerr` : `${ru.origin}`;
        return { ok: true, url: normalized };
      }
    } catch (err) {
      attempts.push(`${new URL(u).pathname}->ERR:${String(err).slice(0,60)}`);
    }
  }
  return { ok: false, url: base, reason: attempts.join(' | ') || 'network/auth/path' };
}

async function overseerrSearch(cfg: OverseerrConfig, query: string, mediaType: "movie" | "tv") {
  const resp = await fetch(`${stripSlash(cfg.url)}/api/v1/search?query=${encodeURIComponent(query)}`, {
    headers: { "X-Api-Key": cfg.apiKey }
  });
  if (!resp.ok) return [] as OverseerrResult[];
  const data = await resp.json() as { results?: OverseerrResult[] };
  return (data.results || []).filter(r => r.mediaType === mediaType);
}

async function overseerrRequest(cfg: OverseerrConfig, item: OverseerrResult) {
  const resp = await fetch(`${stripSlash(cfg.url)}/api/v1/request`, {
    method: "POST",
    headers: { "X-Api-Key": cfg.apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ mediaType: item.mediaType, mediaId: item.id })
  });
  return resp.ok;
}

async function validateProwlarrConfig(inputUrl: string, apiKey: string): Promise<{ ok: boolean; url: string; reason?: string }> {
  const base = stripSlash(inputUrl);
  const candidates = [
    `${base}/api/v1/health`,
    `${base}/prowlarr/api/v1/health`
  ];

  const attempts: string[] = [];

  for (const healthUrl of candidates) {
    try {
      const resp = await fetch(healthUrl, {
        headers: { "X-Api-Key": apiKey, "User-Agent": "pinchy-prowlarr-bot/1.0" },
        redirect: "follow"
      });
      attempts.push(`${new URL(healthUrl).pathname}->${resp.status}`);
      if (resp.ok) {
        const u = new URL(resp.url);
        const normalized = u.pathname.includes('/prowlarr/')
          ? `${u.origin}/prowlarr`
          : `${u.origin}`;
        return { ok: true, url: normalized, reason: `ok ${resp.status}` };
      }
    } catch (err) {
      attempts.push(`${new URL(healthUrl).pathname}->ERR:${String(err).slice(0,80)}`);
    }
  }

  return { ok: false, url: base, reason: attempts.join(' | ') || 'network/auth/path' };
}

async function getSetupState(env: Env, userId: number) {
  return await env.SEARCH_CACHE.get(`setup:${userId}`, "json") as SetupState | null;
}
async function setSetupState(env: Env, userId: number, state: SetupState) {
  await env.SEARCH_CACHE.put(`setup:${userId}`, JSON.stringify(state), { expirationTtl: 60 * 10 });
}
async function clearSetupState(env: Env, userId: number) {
  await env.SEARCH_CACHE.delete(`setup:${userId}`);
}

async function getUserConfig(env: Env, userId: number) {
  return await env.SEARCH_CACHE.get(`cfg:${userId}`, "json") as UserConfig | null;
}
async function setUserConfig(env: Env, userId: number, cfg: UserConfig) {
  await env.SEARCH_CACHE.put(`cfg:${userId}`, JSON.stringify(cfg));
}
async function clearUserConfig(env: Env, userId: number) {
  await env.SEARCH_CACHE.delete(`cfg:${userId}`);
}
async function getOverseerrSetupState(env: Env, userId: number) {
  return await env.SEARCH_CACHE.get(`osetup:${userId}`, "json") as OverseerrSetupState | null;
}
async function setOverseerrSetupState(env: Env, userId: number, state: OverseerrSetupState) {
  await env.SEARCH_CACHE.put(`osetup:${userId}`, JSON.stringify(state), { expirationTtl: 60 * 10 });
}
async function clearOverseerrSetupState(env: Env, userId: number) {
  await env.SEARCH_CACHE.delete(`osetup:${userId}`);
}

async function getOverseerrConfig(env: Env, userId: number) {
  return await env.SEARCH_CACHE.get(`ocfg:${userId}`, "json") as OverseerrConfig | null;
}
async function setOverseerrConfig(env: Env, userId: number, cfg: OverseerrConfig) {
  await env.SEARCH_CACHE.put(`ocfg:${userId}`, JSON.stringify(cfg));
}
async function clearOverseerrConfig(env: Env, userId: number) {
  await env.SEARCH_CACHE.delete(`ocfg:${userId}`);
}


async function resolveConfig(env: Env, userId: number): Promise<UserConfig | null> {
  const userCfg = await getUserConfig(env, userId);
  if (userCfg) return userCfg;
  if (env.PROWLARR_URL && env.PROWLARR_API_KEY) return { url: env.PROWLARR_URL, apiKey: env.PROWLARR_API_KEY };
  return null;
}

async function resolveOverseerrConfig(env: Env, userId: number): Promise<OverseerrConfig | null> {
  const cfg = await getOverseerrConfig(env, userId);
  if (cfg) return cfg;
  if (env.OVERSEERR_URL && env.OVERSEERR_API_KEY) return { url: env.OVERSEERR_URL, apiKey: env.OVERSEERR_API_KEY };
  return null;
}

function isLikelyUrl(value: string) {
  try { new URL(value); return true; } catch { return false; }
}

async function tgSendMessage(env: Env, chatId: number, text: string, reply_markup?: unknown) {
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, reply_markup })
  });
}

async function tgAnswerCallback(env: Env, callbackQueryId: string, text: string) {
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ callback_query_id: callbackQueryId, text, show_alert: false })
  });
}

async function tgEditMessage(env: Env, chatId: number, messageId: number, text: string, reply_markup?: unknown) {
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/editMessageText`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, message_id: messageId, text, reply_markup })
  });
}

function formatUploadDate(value?: string) {
  if (!value) return "unknown";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "unknown";
  return d.toISOString().slice(0, 10);
}

function stripSlash(url: string) { return url.endsWith("/") ? url.slice(0, -1) : url; }
function json(data: unknown) { return new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } }); }
