const puppeteer = require("puppeteer");
const { EventEmitter } = require("events");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const REQUIRED_COOKIES = ["auth_token", "ct0", "twid", "kdt", "att"];

const PACKAGE_NAME = "x-twitter-bot";
const PACKAGE_VERSION = require("./package.json").version;

/**
 * Non-blocking update check against npm registry.
 * Logs a warning to console if a newer version is available.
 */
function _checkForUpdates() {
  const https = require("https");
  const req = https.get(
    `https://registry.npmjs.org/${PACKAGE_NAME}/latest`,
    { timeout: 5000 },
    (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          const latest = JSON.parse(data).version;
          if (latest && latest !== PACKAGE_VERSION) {
            console.log(
              `\x1b[33m[x-twitter-bot] Update available: ${PACKAGE_VERSION} → ${latest}. Run \"npm install ${PACKAGE_NAME}@latest\" to update.\x1b[0m`
            );
          }
        } catch { /* ignore parse errors */ }
      });
    }
  );
  req.on("error", () => { /* silent fail — no network is fine */ });
  req.end();
}

/**
 * Events:
 *   ready           – Bot authenticated and ready to use
 *   loginRequired   – Cookies are invalid/expired, new cookies needed
 *   browserLaunched – Browser instance started
 *   error           – Unrecoverable error during init or operation
 *   tweetPosted     – Tweet posted successfully   → { text, timestamp }
 *   tweetFailed     – Tweet failed                → { text, error }
 *   userFollowed    – User followed successfully   → { username, status, timestamp }
 *   followFailed    – Follow failed                → { username, error }
 *   userUnfollowed  – User unfollowed successfully  → { username, status, timestamp }
 *   unfollowFailed  – Unfollow failed               → { username, error }
 *   closed          – Browser closed
 */
class TwitterBot extends EventEmitter {
  /**
   * @param {object} options
   * @param {object} options.cookies  – { auth_token, ct0, twid, kdt, att, guest_id? }
   * @param {string} [options.username]  – Twitter username (for building tweet URLs)
   * @param {boolean} [options.headless=true]
   * @param {number}  [options.timeout=60000]
   * @param {string}  [options.chromePath]  – Path to Chrome executable (optional)
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
    this.timeout = options.timeout || 600000;
    this.chromePath = options.chromePath || null;

    this.browser = null;
    this.page = null;
    this.isReady = false;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  INIT
  // ═══════════════════════════════════════════════════════════════════════════

  async init() {
    if (this.isReady) return this;

    // Non-blocking update check
    _checkForUpdates();

    try {
      // ── Launch browser ────────────────────────────────────────────────
      const launchOptions = {
        headless: this.headless ? "new" : false,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-blink-features=AutomationControlled",
        ],
        defaultViewport: { width: 1280, height: 720 },
      };

      // Try to use system Chrome if Puppeteer's Chrome is not found
      if (process.platform === "win32") {
        const fs = require("fs");
        const possiblePaths = [
          "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
          "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
          process.env.LOCALAPPDATA + "\\Google\\Chrome\\Application\\chrome.exe",
        ];
        for (const path of possiblePaths) {
          if (fs.existsSync(path)) {
            launchOptions.executablePath = path;
            break;
          }
        }
      }

      this.browser = await puppeteer.launch(launchOptions);

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

  async postTweet(text, options = {}) {
    this._ensureReady();
    if (!text) throw new Error("Tweet text is required");
    if (text.length > 280) throw new Error("Tweet exceeds 280 characters");

    const media = options.media || [];
    if (media.length > 4) throw new Error("Maximum 4 media files allowed");

    try {
      // Handle "Leave site?" / beforeunload dialogs automatically
      // Also handles media upload error dialogs
      let dialogHandled = false;
      const dialogHandler = async (dialog) => {
        if (dialogHandled) return;
        dialogHandled = true;
        await dialog.accept();
      };
      this.page.on("dialog", dialogHandler);

      await this.page.goto("https://x.com/compose/post", {
        waitUntil: "networkidle2",
        timeout: this.timeout,
      });
      await delay(1000);

      const textarea = '[data-testid="tweetTextarea_0"]';
      const found =
        (await this._waitFor(textarea, 10000)) ||
        (await this._waitFor('div[role="textbox"]', 5000));
      if (!found) {
        this.page.off("dialog", dialogHandler);
        throw new Error("Tweet textarea not found");
      }

      await this.page.click(textarea);
      await delay(200);
      await this.page.type(textarea, text, { delay: 30 });
      await delay(500);

      // Upload media files if provided
      if (media.length > 0) {
        const path = require("path");
        const fileInput = await this.page.$('input[data-testid="fileInput"]');
        if (!fileInput) {
          this.page.off("dialog", dialogHandler);
          throw new Error("File input not found");
        }

        for (let filePath of media) {
          // Convert to absolute path if relative
          if (!path.isAbsolute(filePath)) {
            filePath = path.resolve(filePath);
          }
          
          // Check if file exists
          const fs = require("fs");
          if (!fs.existsSync(filePath)) {
            this.page.off("dialog", dialogHandler);
            throw new Error(`File not found: ${filePath}`);
          }

          await fileInput.uploadFile(filePath);
          // Wait for upload to complete - preview appears
          await delay(2500);
          
          // Check for upload errors (X shows a dialog with error message)
          // If dialog was shown, dialogHandled will be true
          if (dialogHandled) {
            this.page.off("dialog", dialogHandler);
            throw new Error("Media upload failed - file may be unsupported or too large");
          }
        }
        // Extra wait for all previews to render
        await delay(1000);
      }

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
      await delay(3000);

      const verification = await this.page.evaluate((tweetText) => {
        // Helper to remove emojis and normalize text
        const normalizeText = (str) => {
          return str
            .replace(/[\u{1F600}-\u{1F64F}]/gu, '') // Emoticons
            .replace(/[\u{1F300}-\u{1F5FF}]/gu, '') // Misc Symbols and Pictographs
            .replace(/[\u{1F680}-\u{1F6FF}]/gu, '') // Transport and Map
            .replace(/[\u{1F700}-\u{1F77F}]/gu, '') // Alchemical Symbols
            .replace(/[\u{1F780}-\u{1F7FF}]/gu, '') // Geometric Shapes Extended
            .replace(/[\u{1F800}-\u{1F8FF}]/gu, '') // Supplemental Arrows-C
            .replace(/[\u{1F900}-\u{1F9FF}]/gu, '') // Supplemental Symbols and Pictographs
            .replace(/[\u{1FA00}-\u{1FA6F}]/gu, '') // Chess Symbols
            .replace(/[\u{1FA70}-\u{1FAFF}]/gu, '') // Symbols and Pictographs Extended-A
            .replace(/[\u{2600}-\u{26FF}]/gu, '')   // Misc symbols
            .replace(/[\u{2700}-\u{27BF}]/gu, '')   // Dingbats
            .trim()
            .replace(/\s+/g, ' ');
        };

        const cells = document.querySelectorAll('[data-testid="cellInnerDiv"]');
        const searchText = normalizeText(tweetText).slice(0, 20); // Use first 20 chars without emojis
        const foundTweets = [];
        
        // Check first 10 cells (to handle promoted tweets, etc)
        for (let i = 0; i < Math.min(cells.length, 10); i++) {
          const cell = cells[i];
          const article = cell.querySelector('article[data-testid="tweet"]');
          if (!article) continue;
          const textEl = article.querySelector('[data-testid="tweetText"]');
          if (!textEl) continue;
          
          const cellText = textEl.innerText;
          foundTweets.push(cellText.slice(0, 50)); // Debug
          
          const normalizedCell = normalizeText(cellText);
          
          if (normalizedCell.includes(searchText)) {
            const timeLink = article.querySelector('a[href*="/status/"] time');
            const statusLink = timeLink ? timeLink.closest("a") : null;
            const href = statusLink ? statusLink.getAttribute("href") : "";
            const match = href.match(/\/status\/(\d+)/);
            const postId = match ? match[1] : null;
            return { found: true, postId, foundTweets };
          }
        }
        return { found: false, postId: null, foundTweets };
      }, text);

      if (!verification.found) {
        console.log("[DEBUG] Searched for:", text.slice(0, 30));
        console.log("[DEBUG] Found tweets:", verification.foundTweets);
        this.page.off("dialog", dialogHandler);
        throw new Error("Tweet not found in feed after posting");
      }

      // Clean up dialog handler
      this.page.off("dialog", dialogHandler);

      const result = {
        success: true,
        text,
        postId: verification.postId,
        timestamp: new Date().toISOString(),
      };
      this.emit("tweetPosted", result);
      return result;
    } catch (err) {
      // Make sure to clean up dialog handler
      if (typeof dialogHandler !== "undefined") {
        try { this.page.off("dialog", dialogHandler); } catch { /* ignore */ }
      }
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

  // ── Follow a user ──────────────────────────────────────────────────────────

  /**
   * Follow a user on X (Twitter).
   * @param {string} username – The username to follow (without @)
   * @returns {Promise<{username: string, status: 'followed'|'already_following'|'failed', timestamp: string}>}
   */
  async followUser(username) {
    this._ensureReady();
    if (!username) throw new Error("Username is required");

    // Strip @ if provided
    username = username.replace(/^@/, "");

    try {
      await this.page.goto(`https://x.com/${username}`, {
        waitUntil: "networkidle2",
        timeout: this.timeout,
      });
      await delay(2000);

      // Check if the profile page loaded correctly (not a 404 / suspended)
      const profileExists = await this.page.evaluate(() => {
        const errorHeading = document.querySelector('[data-testid="empty_state_header_text"]');
        if (errorHeading) return false;
        if (document.querySelector('[data-testid="UserName"]')) return true;
        if (document.querySelector('[data-testid="UserAvatar-Container-unknown"]')) return false;
        return true;
      });

      if (!profileExists) {
        throw new Error(`User @${username} not found or account is suspended`);
      }

      // Detect follow state.
      // On subscription accounts, the "Subscribe" button also has data-testid$="-unfollow"
      // but with a colored background. The real unfollow button has transparent bg (rgba(0,0,0,0))
      // or is a separate button whose aria-label contains "@".
      const followState = await this.page.evaluate(() => {
        // Check for transparent-bg unfollow button (normal accounts)
        const unfollowBtn = document.querySelector('[data-testid$="-unfollow"]');
        if (unfollowBtn) {
          const bg = unfollowBtn.style.backgroundColor;
          if (bg === "rgba(0, 0, 0, 0)" || bg === "transparent") return "already_following";
        }

        // Check for aria-label unfollow button with @ (subscription accounts)
        const allButtons = document.querySelectorAll('button[role="button"]');
        for (const btn of allButtons) {
          const label = btn.getAttribute("aria-label") || "";
          if (label.includes("@") && btn.getAttribute("aria-haspopup") === "menu") {
            return "already_following";
          }
        }

        const followBtn = document.querySelector('[data-testid$="-follow"]');
        if (followBtn) return "not_following";

        return "unknown";
      });

      if (followState === "already_following") {
        return {
          username,
          status: "already_following",
          timestamp: new Date().toISOString(),
        };
      }

      if (followState === "unknown") {
        throw new Error(`Could not detect follow button for @${username}`);
      }

      // Click the follow button
      await this.page.evaluate(() => {
        const btn = document.querySelector('[data-testid$="-follow"]');
        if (btn) btn.click();
      });

      await delay(2000);

      // Verify follow succeeded
      const confirmed = await this.page.evaluate(() => {
        // Check transparent-bg unfollow button
        const unfollowBtn = document.querySelector('[data-testid$="-unfollow"]');
        if (unfollowBtn) {
          const bg = unfollowBtn.style.backgroundColor;
          if (bg === "rgba(0, 0, 0, 0)" || bg === "transparent") return true;
        }
        // Check aria-label unfollow button with @
        const allButtons = document.querySelectorAll('button[role="button"]');
        for (const btn of allButtons) {
          const label = btn.getAttribute("aria-label") || "";
          if (label.includes("@") && btn.getAttribute("aria-haspopup") === "menu") return true;
        }
        return false;
      });

      if (!confirmed) {
        throw new Error(`Follow action for @${username} did not complete`);
      }

      const result = {
        username,
        status: "followed",
        timestamp: new Date().toISOString(),
      };
      this.emit("userFollowed", result);
      return result;
    } catch (err) {
      this.emit("followFailed", { username, error: err.message });
      throw err;
    }
  }

  // ── Unfollow a user ────────────────────────────────────────────────────────

  /**
   * Unfollow a user on X (Twitter).
   * @param {string} username – The username to unfollow (without @)
   * @returns {Promise<{username: string, status: 'unfollowed'|'not_following'|'failed', timestamp: string}>}
   */
  async unfollowUser(username) {
    this._ensureReady();
    if (!username) throw new Error("Username is required");

    // Strip @ if provided
    username = username.replace(/^@/, "");

    try {
      await this.page.goto(`https://x.com/${username}`, {
        waitUntil: "networkidle2",
        timeout: this.timeout,
      });
      await delay(2000);

      // Check if the profile page loaded correctly
      const profileExists = await this.page.evaluate(() => {
        const errorHeading = document.querySelector('[data-testid="empty_state_header_text"]');
        if (errorHeading) return false;
        if (document.querySelector('[data-testid="UserName"]')) return true;
        if (document.querySelector('[data-testid="UserAvatar-Container-unknown"]')) return false;
        return true;
      });

      if (!profileExists) {
        throw new Error(`User @${username} not found or account is suspended`);
      }

      // Detect follow state.
      // Subscription accounts have two buttons with data-testid$="-unfollow":
      //   1) Subscribe button → colored background (e.g. purple)
      //   2) Real unfollow button → transparent background rgba(0,0,0,0)
      //      OR a separate button with aria-label containing "@" and aria-haspopup="menu"
      const followState = await this.page.evaluate(() => {
        // Check transparent-bg unfollow button (normal accounts)
        const unfollowBtn = document.querySelector('[data-testid$="-unfollow"]');
        if (unfollowBtn) {
          const bg = unfollowBtn.style.backgroundColor;
          if (bg === "rgba(0, 0, 0, 0)" || bg === "transparent") return "following";
        }

        // Check aria-label button with @ (subscription accounts)
        const allButtons = document.querySelectorAll('button[role="button"]');
        for (const btn of allButtons) {
          const label = btn.getAttribute("aria-label") || "";
          if (label.includes("@") && btn.getAttribute("aria-haspopup") === "menu") {
            return "following";
          }
        }

        const followBtn = document.querySelector('[data-testid$="-follow"]');
        if (followBtn) return "not_following";

        return "unknown";
      });

      if (followState === "not_following") {
        return {
          username,
          status: "not_following",
          timestamp: new Date().toISOString(),
        };
      }

      if (followState === "unknown") {
        throw new Error(`Could not detect follow/unfollow button for @${username}`);
      }

      // Click the correct unfollow button:
      //   Priority 1: data-testid$="-unfollow" with transparent bg → normal account
      //   Priority 2: button with aria-label containing "@" + aria-haspopup="menu" → subscription account
      const clickedType = await this.page.evaluate(() => {
        // Priority 1: transparent-bg unfollow button
        const unfollowBtn = document.querySelector('[data-testid$="-unfollow"]');
        if (unfollowBtn) {
          const bg = unfollowBtn.style.backgroundColor;
          if (bg === "rgba(0, 0, 0, 0)" || bg === "transparent") {
            unfollowBtn.click();
            return "normal";
          }
        }

        // Priority 2: aria-label button with @ (subscription accounts)
        const allButtons = document.querySelectorAll('button[role="button"]');
        for (const btn of allButtons) {
          const label = btn.getAttribute("aria-label") || "";
          if (label.includes("@") && btn.getAttribute("aria-haspopup") === "menu") {
            btn.click();
            return "subscription";
          }
        }

        return null;
      });

      if (!clickedType) {
        throw new Error(`Could not find unfollow button for @${username}`);
      }

      await delay(1500);

      // Two possible flows after clicking:
      //   A) Normal accounts → confirmation dialog with data-testid="confirmationSheetConfirm"
      //   B) Subscription accounts → dropdown menu (role="menu") → click menuitem with @username

      // Try Flow A: confirmation dialog
      let unfollowConfirmed = await this.page.evaluate(() => {
        const confirmBtn = document.querySelector('[data-testid="confirmationSheetConfirm"]');
        if (confirmBtn) {
          confirmBtn.click();
          return true;
        }
        return false;
      });

      if (!unfollowConfirmed) {
        // Try Flow B: dropdown menu — click the menuitem whose text contains @username
        unfollowConfirmed = await this.page.evaluate((uname) => {
          const menu = document.querySelector('[role="menu"]');
          if (!menu) return false;

          const items = menu.querySelectorAll('[role="menuitem"]');
          for (const item of items) {
            const text = item.innerText.toLowerCase();
            if (text.includes("@" + uname.toLowerCase())) {
              item.click();
              return true;
            }
          }

          // Fallback: click the first menuitem if only one exists
          if (items.length === 1) {
            items[0].click();
            return true;
          }

          return false;
        }, username);

        if (!unfollowConfirmed) {
          throw new Error(`Unfollow confirmation not found for @${username}`);
        }

        await delay(1000);

        // After dropdown click, there may still be a confirmation dialog
        await this.page.evaluate(() => {
          const confirmBtn = document.querySelector('[data-testid="confirmationSheetConfirm"]');
          if (confirmBtn) confirmBtn.click();
        });
      }

      await delay(2000);

      // Verify unfollow succeeded – follow button should appear
      const verified = await this.page.evaluate(() => {
        return !!document.querySelector('[data-testid$="-follow"]');
      });

      if (!verified) {
        throw new Error(`Unfollow action for @${username} did not complete`);
      }

      const result = {
        username,
        status: "unfollowed",
        timestamp: new Date().toISOString(),
      };
      this.emit("userUnfollowed", result);
      return result;
    } catch (err) {
      this.emit("unfollowFailed", { username, error: err.message });
      throw err;
    }
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
