import type { Page } from "playwright";
import { getContext } from "./browser.js";
import { humanize, jitter } from "./antiBlock.js";
import { env } from "./env.js";

export type ScrapedPost = {
  external_id: string;
  post_type: "feed" | "reel" | "carousel" | "story";
  caption: string | null;
  hashtags: string[];
  mentions: string[];
  media_urls: string[];
  thumbnail_url: string | null;
  posted_at: string;
  likes: number | null;
  comments: number | null;
  views: number | null;
};

export type ProfileScrapeResult = {
  display_name: string | null;
  avatar_url: string | null;
  bio: string | null;
  followers_count: number | null;
  posts: ScrapedPost[];
};

function parseCount(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const s = raw.trim().toLowerCase().replace(/\u00a0/g, "").replace(/\./g, "").replace(",", ".");
  const m = s.match(/^([\d.]+)\s*(mil|mi|k|m|b)?/);
  if (!m) return null;
  const num = parseFloat(m[1]);
  const mult = ((): number => {
    switch (m[2]) {
      case "mil":
      case "k":
        return 1_000;
      case "mi":
      case "m":
        return 1_000_000;
      case "b":
        return 1_000_000_000;
      default:
        return 1;
    }
  })();
  return Math.round(num * mult);
}

function extractTags(caption: string | null): { hashtags: string[]; mentions: string[] } {
  if (!caption) return { hashtags: [], mentions: [] };
  const hashtags = Array.from(new Set((caption.match(/#[\w_.]+/g) || []).map((t) => t.slice(1).toLowerCase())));
  const mentions = Array.from(new Set((caption.match(/@[\w_.]+/g) || []).map((t) => t.slice(1).toLowerCase())));
  return { hashtags, mentions };
}

export async function crawlProfile(username: string): Promise<ProfileScrapeResult> {
  const ctx = await getContext();
  const page: Page = await ctx.newPage();

  try {
    const url = `https://www.instagram.com/${encodeURIComponent(username)}/`;
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await jitter(1500, 3000);

    const blocked = await page.locator("text=/log in to instagram/i").first().isVisible().catch(() => false);
    if (blocked) {
      throw new Error("instagram_login_wall");
    }

    await humanize(page);

    const meta = await page.evaluate(() => {
      const followers = document.querySelector('a[href$="/followers/"] span span, header li:nth-child(2) span')?.getAttribute("title")
        || document.querySelector('a[href$="/followers/"] span')?.textContent
        || null;
      const displayName = document.querySelector("header h2, header h1")?.textContent?.trim() || null;
      const bio = document.querySelector("header section > div:nth-child(3)")?.textContent?.trim() || null;
      const avatar = (document.querySelector("header img") as HTMLImageElement | null)?.src || null;
      return { followers, displayName, bio, avatar };
    });

    const followers_count = parseCount(meta.followers);

    const postLinks = await page.$$eval(
      'article a[href*="/p/"], article a[href*="/reel/"]',
      (els) =>
        Array.from(
          new Set(
            els
              .slice(0, 24)
              .map((e) => (e as HTMLAnchorElement).href)
              .filter((h) => /\/(p|reel)\//.test(h)),
          ),
        ),
    );

    const posts: ScrapedPost[] = [];
    for (const link of postLinks.slice(0, env.MAX_POSTS_PER_RUN)) {
      try {
        const shortcodeMatch = link.match(/\/(p|reel)\/([^/?]+)/);
        if (!shortcodeMatch) continue;
        const post_type: ScrapedPost["post_type"] = shortcodeMatch[1] === "reel" ? "reel" : "feed";
        const external_id = shortcodeMatch[2];

        const thumb = await page
          .locator(`a[href*="/${external_id}/"] img`)
          .first()
          .getAttribute("src")
          .catch(() => null);

        const post = await ctx.newPage();
        await post.goto(link, { waitUntil: "domcontentloaded", timeout: 30_000 });
        await jitter(1200, 2400);

        const data = await post.evaluate(() => {
          const time = document.querySelector("time")?.getAttribute("datetime") || null;
          const caption =
            document.querySelector("article h1")?.textContent
            || document.querySelector("article div[role='button'] + span, article ul li span")?.textContent
            || null;
          const likesNode = document.querySelector('section a[href$="/liked_by/"] span span');
          const likesText = likesNode?.textContent || null;
          const isCarousel = !!document.querySelector('article ul > li ~ li button');
          return { time, caption, likesText, isCarousel };
        });

        const { hashtags, mentions } = extractTags(data.caption);
        posts.push({
          external_id,
          post_type: data.isCarousel ? "carousel" : post_type,
          caption: data.caption,
          hashtags,
          mentions,
          media_urls: thumb ? [thumb] : [],
          thumbnail_url: thumb,
          posted_at: data.time || new Date().toISOString(),
          likes: parseCount(data.likesText),
          comments: null,
          views: null,
        });
        await post.close();
        await jitter(800, 1800);
      } catch (e) {
        console.warn(`[crawler] post error`, (e as Error).message);
      }
    }

    return {
      display_name: meta.displayName,
      avatar_url: meta.avatar,
      bio: meta.bio,
      followers_count,
      posts,
    };
  } finally {
    try { await page.close(); } catch { /* ignore */ }
  }
}
