const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
];

const VIEWPORTS = [
  { width: 1366, height: 768 },
  { width: 1440, height: 900 },
  { width: 1536, height: 864 },
  { width: 1920, height: 1080 },
];

const LOCALES = ["pt-BR", "en-US"];

export function pickUserAgent() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}
export function pickViewport() {
  return VIEWPORTS[Math.floor(Math.random() * VIEWPORTS.length)];
}
export function pickLocale() {
  return LOCALES[Math.floor(Math.random() * LOCALES.length)];
}

export function jitter(minMs: number, maxMs: number): Promise<void> {
  const ms = minMs + Math.random() * (maxMs - minMs);
  return new Promise((res) => setTimeout(res, ms));
}

export async function humanize(page: import("playwright").Page) {
  const vw = page.viewportSize() || { width: 1366, height: 768 };
  for (let i = 0; i < 3; i++) {
    await page.mouse.move(
      Math.random() * vw.width,
      Math.random() * vw.height,
      { steps: 5 + Math.floor(Math.random() * 10) },
    );
    await jitter(200, 600);
  }
}
