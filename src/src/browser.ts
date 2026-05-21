import { chromium, Browser, BrowserContext } from "playwright";
import { env } from "./env.js";
import { pickLocale, pickUserAgent, pickViewport } from "./antiBlock.js";

let browser: Browser | null = null;
let context: BrowserContext | null = null;
let contextUseCount = 0;
const MAX_USES_PER_CONTEXT = 25;

export async function getBrowser(): Promise<Browser> {
  if (browser && browser.isConnected()) return browser;
  browser = await chromium.launch({
    headless: env.HEADLESS,
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-blink-features=AutomationControlled",
    ],
    proxy: env.PROXY_URL ? { server: env.PROXY_URL } : undefined,
  });
  return browser;
}

export async function getContext(): Promise<BrowserContext> {
  if (context && contextUseCount < MAX_USES_PER_CONTEXT) {
    contextUseCount++;
    return context;
  }
  if (context) {
    try { await context.close(); } catch { /* ignore */ }
  }
  const b = await getBrowser();
  context = await b.newContext({
    userAgent: pickUserAgent(),
    viewport: pickViewport(),
    locale: pickLocale(),
    timezoneId: "America/Sao_Paulo",
    bypassCSP: true,
  });
  await context.route("**/*", (route) => {
    const type = route.request().resourceType();
    if (type === "media" || type === "font") return route.abort();
    route.continue();
  });
  contextUseCount = 1;
  return context;
}

export async function shutdown() {
  try { if (context) await context.close(); } catch { /* ignore */ }
  try { if (browser) await browser.close(); } catch { /* ignore */ }
  context = null;
  browser = null;
}

process.on("SIGINT", async () => { await shutdown(); process.exit(0); });
process.on("SIGTERM", async () => { await shutdown(); process.exit(0); });
