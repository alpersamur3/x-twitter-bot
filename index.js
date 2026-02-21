const puppeteer = require("puppeteer");
const { EventEmitter } = require("events");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const REQUIRED_COOKIES = ["auth_token", "ct0", "twid", "kdt", "att"];

/**
 * Events:
 *   ready           – Bot authenticated and ready to use
 *   loginRequired   – Cookies are invalid/expired, new cookies needed
 *   browserLaunched – Browser instance started
 *   error           – Unrecoverable error during init or operation
 *   tweetPosted     – Tweet posted successfully   → { text, timestamp }
 *   tweetFailed     – Tweet failed                → { text, error }
 *   closed          – Browser closed
 */
class TwitterBot extends EventEmitter {
  /**
   * @param {object} options
   * @param {object} options.cookies  – { auth_token, ct0, twid, kdt, att, guest_id? }
   * @param {string} [options.username]  – Twitter username (for building tweet URLs)
   * @param {boolean} [options.headless=true]
   * @param {number}  [options.timeout=60000]
   */
  constructor(options = {}) {
    super();

    if (!options.cookies) throw new Error("cookies is required");

    for (const name of REQUIRED_COOKIES) {
      if (!options.cookies[name]) {
        throw new Error(`Missing required cookie: ${name}`);
      }
    }

    this.cookies = options.cookies;
    this.username = options.username || "";
    this.headless = options.headless !== undefined ? options.headless : true;
    this.timeout = options.timeout || 60000;

    this.browser = null;
    this.page = null;
    this.isReady = false;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  INIT
  // ═══════════════════════════════════════════════════════════════════════════

  async init() {
    if (this.isReady) return this;

    try {
      // ── Launch browser ────────────────────────────────────────────────
      this.browser = await puppeteer.launch({
        headless: this.headless ? "new" : false,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-blink-features=AutomationControlled",
        ],
        defaultViewport: { width: 1280, height: 720 },
      });

      this.page = await this.browser.newPage();

      await this.page.setUserAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
      );

      await this.page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, "webdriver", { get: () => undefined });
      });

      this.emit("browserLaunched");

      // ── Set cookies & open x.com ──────────────────────────────────────
      const cookieObjects = this._buildCookieObjects();
      await this.page.setCookie(...cookieObjects);

      await this.page.goto("https://x.com/home", {
        waitUntil: "networkidle2",
        timeout: this.timeout,
      });

      // ── Verify auth ──────────────────────────────────────────────────
      await delay(1500);

      const currentUrl = this.page.url();

      if (currentUrl.includes("/login") || currentUrl.includes("/i/flow/login")) {
        this.isReady = false;
        this.emit("loginRequired");
        return this;
      }

      // Double-check with DOM — look for logged-in sidebar
      const hasProfile = await this._waitFor(
        '[data-testid="AppTabBar_Profile_Link"], [data-testid="SideNav_AccountSwitcher_Button"]',
        5000
      );

      if (!hasProfile) {
        const recheckUrl = this.page.url();
        if (recheckUrl.includes("/login") || recheckUrl.includes("/i/flow/login")) {
          this.isReady = false;
          this.emit("loginRequired");
          return this;
        }
      }

      this.isReady = true;
      this.emit("ready");
      return this;
    } catch (err) {
      this.emit("error", err);
      return this;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  ACTIONS
  // ═══════════════════════════════════════════════════════════════════════════

  // ── Post a tweet ─────────────────────────────────────────────────────────

  async postTweet(text) {
    this._ensureReady();
    if (!text) throw new Error("Tweet text is required");
    if (text.length > 280) throw new Error("Tweet exceeds 280 characters");

    try {
      // Handle "Leave site?" / beforeunload dialogs automatically
      this.page.once("dialog", async (dialog) => {
        await dialog.accept();
      });

      await this.page.goto("https://x.com/compose/post", {
        waitUntil: "networkidle2",
        timeout: this.timeout,
      });
      await delay(1000);

      const textarea = '[data-testid="tweetTextarea_0"]';
      const found =
        (await this._waitFor(textarea, 10000)) ||
        (await this._waitFor('div[role="textbox"]', 5000));
      if (!found) throw new Error("Tweet textarea not found");

      await this.page.click(textarea);
      await delay(200);
      await this.page.type(textarea, text, { delay: 30 });
      await delay(500);

      const clicked = await this.page.evaluate(() => {
        const btn =
          document.querySelector('[data-testid="tweetButton"]') ||
          document.querySelector('[data-testid="tweetButtonInline"]');
        if (btn) {
          btn.click();
          return true;
        }
        return false;
      });

      if (!clicked) throw new Error("Post button not found");

      // Wait for compose to close (URL changes via SPA, no real navigation)
      await delay(4000);

      const stillOnCompose = await this.page.evaluate(() =>
        window.location.href.includes("/compose")
      );

      if (stillOnCompose) {
        // Still on compose = tweet failed. Read toast for error reason.
        const toastText = await this.page.evaluate(() => {
          const toast = document.querySelector('[role="status"]');
          return toast ? toast.innerText.trim() : "";
        });
        await this._dismissCompose();
        throw new Error(toastText || "Tweet could not be posted");
      }

      // URL changed → we're on home/feed now. Find our tweet at the top.
      await delay(2000);

      const verification = await this.page.evaluate((tweetText) => {
        const cells = document.querySelectorAll('[data-testid="cellInnerDiv"]');
        for (const cell of cells) {
          const article = cell.querySelector('article[data-testid="tweet"]');
          if (!article) continue;
          const textEl = article.querySelector('[data-testid="tweetText"]');
          if (!textEl) continue;
          if (textEl.innerText.includes(tweetText.slice(0, 30))) {
            const timeLink = article.querySelector('a[href*="/status/"] time');
            const statusLink = timeLink ? timeLink.closest("a") : null;
            const href = statusLink ? statusLink.getAttribute("href") : "";
            const match = href.match(/\/status\/(\d+)/);
            const postId = match ? match[1] : null;
            return { found: true, postId };
          }
        }
        return { found: false, postId: null };
      }, text);

      if (!verification.found) {
        throw new Error("Tweet not found in feed after posting");
      }

      const result = {
        success: true,
        text,
        postId: verification.postId,
        timestamp: new Date().toISOString(),
      };
      this.emit("tweetPosted", result);
      return result;
    } catch (err) {
      try { await this._recoverPage(); } catch { /* ignore */ }
      this.emit("tweetFailed", { text, error: err.message });
      throw err;
    }
  }

  // ── Get tweet stats + initial visible replies ─────────────────────────────

  async getTweetStats(tweetId) {
    this._ensureReady();
    if (!tweetId) throw new Error("Tweet ID is required");

    const url = this._tweetUrl(tweetId);

    await this.page.goto(url, {
      waitUntil: "networkidle2",
      timeout: this.timeout,
    });
    await delay(1500);

    const data = await this.page.evaluate(() => {
      const r = {
        text: "",
        likes: 0,
        replies: 0,
        reposts: 0,
        views: 0,
        bookmarks: 0,
        initialReplies: [],
      };

      // ── Main tweet stats ──────────────────────────────────────────
      const tweetText = document.querySelector('[data-testid="tweetText"]');
      if (tweetText) r.text = tweetText.innerText;

      const parse = (testId) => {
        const el =
          document.querySelector(`[data-testid="${testId}"]`) ||
          document.querySelector(`[data-testid="un${testId}"]`);
        if (el) {
          const m = (el.getAttribute("aria-label") || "").match(/(\d+)/);
          if (m) return parseInt(m[1]);
        }
        return 0;
      };

      r.replies = parse("reply");
      r.reposts = parse("retweet");

      r.likes = (() => {
        const el =
          document.querySelector('[data-testid="like"]') ||
          document.querySelector('[data-testid="unlike"]');
        if (el) {
          const m = (el.getAttribute("aria-label") || "").match(/(\d+)/);
          if (m) return parseInt(m[1]);
        }
        return 0;
      })();

      r.bookmarks = (() => {
        const el =
          document.querySelector('[data-testid="bookmark"]') ||
          document.querySelector('[data-testid="removeBookmark"]');
        if (el) {
          const m = (el.getAttribute("aria-label") || "").match(/(\d+)/);
          if (m) return parseInt(m[1]);
        }
        return 0;
      })();

      const allLinks = document.querySelectorAll("a[aria-label]");
      for (const el of allLinks) {
        const label = el.getAttribute("aria-label") || "";
        if (/view/i.test(label) || /görüntülenme/i.test(label)) {
          const m = label.match(/([\d,.]+)/);
          if (m) {
            r.views = parseInt(m[1].replace(/[,.]/g, ""));
            break;
          }
        }
      }

      // ── Initial visible replies (no scroll) ──────────────────────
      const cells = document.querySelectorAll('[data-testid="cellInnerDiv"]');
      let foundMainTweet = false;

      for (const cell of cells) {
        const article = cell.querySelector('article[data-testid="tweet"]');
        if (!article) continue;

        if (!foundMainTweet) {
          foundMainTweet = true;
          continue;
        }

        const reply = { tweetId: null, username: "", handle: "", text: "", time: "", likes: 0, replies: 0, reposts: 0 };

        // Extract tweet ID from permalink
        const permalink = article.querySelector('a[href*="/status/"] time')?.closest("a");
        if (permalink) {
          const match = permalink.getAttribute("href").match(/\/status\/(\d+)/);
          if (match) reply.tweetId = match[1];
        }

        const userNameEl = article.querySelector('[data-testid="User-Name"]');
        if (userNameEl) {
          const spans = userNameEl.querySelectorAll("a");
          if (spans[0]) {
            const nameSpan = spans[0].querySelector("span span");
            if (nameSpan) reply.username = nameSpan.innerText;
          }
          if (spans[1]) {
            const handleSpan = spans[1].querySelector("span");
            if (handleSpan) reply.handle = handleSpan.innerText;
          }
        }

        const timeEl = article.querySelector("time");
        if (timeEl) reply.time = timeEl.getAttribute("datetime") || timeEl.innerText;

        const textEl = article.querySelector('[data-testid="tweetText"]');
        if (textEl) reply.text = textEl.innerText;

        const parseBtn = (testId) => {
          const el =
            article.querySelector(`[data-testid="${testId}"]`) ||
            article.querySelector(`[data-testid="un${testId}"]`);
          if (el) {
            const m = (el.getAttribute("aria-label") || "").match(/(\d+)/);
            if (m) return parseInt(m[1]);
          }
          return 0;
        };

        reply.replies = parseBtn("reply");
        reply.reposts = parseBtn("retweet");
        reply.likes = (() => {
          const el =
            article.querySelector('[data-testid="like"]') ||
            article.querySelector('[data-testid="unlike"]');
          if (el) {
            const m = (el.getAttribute("aria-label") || "").match(/(\d+)/);
            if (m) return parseInt(m[1]);
          }
          return 0;
        })();

        r.initialReplies.push(reply);
      }

      return r;
    });

    return { id: tweetId, url, ...data };
  }

  // ── Get tweet comments (with scroll & count limit) ────────────────────────

  async getTweetComments(tweetId, count = 20) {
    this._ensureReady();
    if (!tweetId) throw new Error("Tweet ID is required");

    const url = this._tweetUrl(tweetId);

    if (!this.page.url().includes(`/status/${tweetId}`)) {
      await this.page.goto(url, {
        waitUntil: "networkidle2",
        timeout: this.timeout,
      });
    }
    await delay(2000);

    // Get actual reply count from the page to cap requested count
    const actualReplyCount = await this.page.evaluate(() => {
      const replyBtn = document.querySelector('[data-testid="reply"]');
      if (replyBtn) {
        const m = (replyBtn.getAttribute("aria-label") || "").match(/(\d+)/);
        if (m) return parseInt(m[1]);
      }
      return 0;
    });

    const targetCount = Math.min(count, actualReplyCount || count);

    const collectedMap = new Map(); // tweetId → comment (dedup)
    let scrollBlocked = false;
    let noNewDataRetries = 0;
    const MAX_RETRIES = 5;

    const scrapeVisibleComments = async () => {
      return await this.page.evaluate(() => {
        const results = [];
        const cells = document.querySelectorAll('[data-testid="cellInnerDiv"]');
        let foundMainTweet = false;

        for (const cell of cells) {
          const article = cell.querySelector('article[data-testid="tweet"]');
          if (!article) continue;

          if (!foundMainTweet) {
            foundMainTweet = true;
            continue;
          }

          const comment = {
            tweetId: null,
            username: "",
            handle: "",
            text: "",
            time: "",
            likes: 0,
            replies: 0,
            reposts: 0,
          };

          // Extract tweet ID from permalink
          const permalink = article.querySelector('a[href*="/status/"] time')?.closest("a");
          if (permalink) {
            const match = permalink.getAttribute("href").match(/\/status\/(\d+)/);
            if (match) comment.tweetId = match[1];
          }

          const userNameEl = article.querySelector('[data-testid="User-Name"]');
          if (userNameEl) {
            const spans = userNameEl.querySelectorAll("a");
            if (spans[0]) {
              const nameSpan = spans[0].querySelector("span span");
              if (nameSpan) comment.username = nameSpan.innerText;
            }
            if (spans[1]) {
              const handleSpan = spans[1].querySelector("span");
              if (handleSpan) comment.handle = handleSpan.innerText;
            }
          }

          const timeEl = article.querySelector("time");
          if (timeEl) comment.time = timeEl.getAttribute("datetime") || timeEl.innerText;

          const textEl = article.querySelector('[data-testid="tweetText"]');
          if (textEl) comment.text = textEl.innerText;

          const parseBtn = (testId) => {
            const el =
              article.querySelector(`[data-testid="${testId}"]`) ||
              article.querySelector(`[data-testid="un${testId}"]`);
            if (el) {
              const m = (el.getAttribute("aria-label") || "").match(/(\d+)/);
              if (m) return parseInt(m[1]);
            }
            return 0;
          };

          comment.replies = parseBtn("reply");
          comment.reposts = parseBtn("retweet");
          comment.likes = (() => {
            const el =
              article.querySelector('[data-testid="like"]') ||
              article.querySelector('[data-testid="unlike"]');
            if (el) {
              const m = (el.getAttribute("aria-label") || "").match(/(\d+)/);
              if (m) return parseInt(m[1]);
            }
            return 0;
          })();

          results.push(comment);
        }

        return results;
      });
    };

    // ── Scroll loop ──────────────────────────────────────────────────
    while (collectedMap.size < targetCount) {
      const visible = await scrapeVisibleComments();

      let newFound = 0;
      for (const c of visible) {
        const key = c.tweetId || `${c.handle}_${c.text}`;
        if (!collectedMap.has(key)) {
          collectedMap.set(key, c);
          newFound++;
        }
        if (collectedMap.size >= targetCount) break;
      }

      if (collectedMap.size >= targetCount) break;

      if (newFound === 0) {
        noNewDataRetries++;
        if (noNewDataRetries >= MAX_RETRIES) {
          scrollBlocked = true;
          break;
        }
      } else {
        noNewDataRetries = 0;
      }

      // Scroll down
      const prevHeight = await this.page.evaluate(() => document.body.scrollHeight);
      await this.page.evaluate(() => window.scrollBy(0, 800));
      await delay(1500);
      const newHeight = await this.page.evaluate(() => document.body.scrollHeight);

      // Detect if scroll is physically blocked (page height didn't change)
      if (newHeight === prevHeight) {
        noNewDataRetries++;
        if (noNewDataRetries >= MAX_RETRIES) {
          scrollBlocked = true;
          break;
        }
        // Wait a bit longer before retrying
        await delay(1000);
      }
    }

    const comments = Array.from(collectedMap.values()).slice(0, targetCount);

    return {
      id: tweetId,
      url,
      requested: count,
      actualReplyCount,
      collected: comments.length,
      scrollBlocked,
      comments,
    };
  }

  // ── Search & like tweets ─────────────────────────────────────────────────

  async searchAndLike(query, count = 5) {
    this._ensureReady();
    if (!query) throw new Error("Search query is required");

    await this.page.goto(
      `https://x.com/search?q=${encodeURIComponent(query)}&src=typed_query&f=live`,
      { waitUntil: "networkidle2", timeout: this.timeout }
    );
    await delay(1000);

    const likeButtons = await this.page.$$('[data-testid="like"]');
    const likesToDo = Math.min(count, likeButtons.length);
    let liked = 0;

    for (let i = 0; i < likesToDo; i++) {
      try {
        await likeButtons[i].click();
        liked++;
        await delay(1000 + Math.random() * 1000);
      } catch {
        /* skip */
      }
    }

    return { query, liked };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  LIFECYCLE
  // ═══════════════════════════════════════════════════════════════════════════

  async close() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      this.page = null;
      this.isReady = false;
      this.emit("closed");
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  INTERNALS
  // ═══════════════════════════════════════════════════════════════════════════

  _ensureReady() {
    if (!this.isReady) {
      throw new Error("Bot not ready. Call .init() and wait for 'ready' event.");
    }
  }

  _tweetUrl(tweetId) {
    if (this.username) {
      return `https://x.com/${this.username}/status/${tweetId}`;
    }
    return `https://x.com/i/status/${tweetId}`;
  }

  async _waitFor(selector, timeout = 10000) {
    try {
      await this.page.waitForSelector(selector, { timeout });
      return true;
    } catch {
      return false;
    }
  }

  async _dismissCompose() {
    // Try to close the compose modal/page without triggering beforeunload issues.
    // Accept any "Leave site?" dialog that appears.
    this.page.once("dialog", async (dialog) => {
      await dialog.accept();
    });

    try {
      // Try clicking the close button on the compose modal
      const closed = await this.page.evaluate(() => {
        const closeBtn = document.querySelector('[data-testid="app-bar-close"]');
        if (closeBtn) { closeBtn.click(); return true; }
        return false;
      });
      if (closed) {
        await delay(500);
        // There may be a "Discard" confirmation — click it
        await this.page.evaluate(() => {
          const btns = document.querySelectorAll('[role="button"]');
          for (const btn of btns) {
            const t = btn.innerText.toLowerCase();
            if (t === "discard" || t === "at" || t === "vazgeç") {
              btn.click();
              return;
            }
          }
        });
        await delay(500);
      }
    } catch { /* page may be dead, that's ok */ }
  }

  async _recoverPage() {
    // Accept any "Leave site?" beforeunload dialogs
    this.page.once("dialog", async (dialog) => {
      await dialog.accept();
    });

    try {
      // Quick check — if we can read the URL, the page is alive
      this.page.url();
      await this.page.goto("https://x.com/home", {
        waitUntil: "domcontentloaded",
        timeout: this.timeout,
      });
    } catch {
      // Page is dead — create a new tab
      const pages = await this.browser.pages();
      let recovered = false;
      for (const p of pages) {
        try {
          p.url();
          this.page = p;
          this.page.once("dialog", async (d) => await d.accept());
          await this.page.goto("https://x.com/home", {
            waitUntil: "domcontentloaded",
            timeout: this.timeout,
          });
          recovered = true;
          break;
        } catch { /* dead page, skip */ }
      }

      if (!recovered) {
        this.page = await this.browser.newPage();
        await this.page.setUserAgent(
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        );
        await this.page.evaluateOnNewDocument(() => {
          Object.defineProperty(navigator, "webdriver", { get: () => undefined });
        });
        const cookieObjects = this._buildCookieObjects();
        await this.page.setCookie(...cookieObjects);
        await this.page.goto("https://x.com/home", {
          waitUntil: "domcontentloaded",
          timeout: this.timeout,
        });
      }
    }
    await delay(1000);
  }

  _buildCookieObjects() {
    return Object.entries(this.cookies).map(([name, value]) => {
      const base = {
        name,
        value,
        domain: ".x.com",
        path: "/",
        expires: Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60,
        secure: true,
        sameSite: "None",
      };

      if (name === "auth_token" || name === "kdt" || name === "att") {
        base.httpOnly = true;
      } else {
        base.httpOnly = false;
      }

      if (name === "ct0") base.sameSite = "Lax";
      if (name === "kdt") base.sameSite = "Strict";

      return base;
    });
  }
}

module.exports = TwitterBot;
