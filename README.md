# x-twitter-bot

**Node.js Twitter/X automation library** — post tweets, scrape stats & comments, search and like, all with cookie-based auth. No official API key required.

Built on [Puppeteer](https://pptr.dev/). EventEmitter-based, headless Chrome automation.

[![npm version](https://img.shields.io/npm/v/x-twitter-bot.svg)](https://www.npmjs.com/package/x-twitter-bot)
[![npm downloads](https://img.shields.io/npm/dm/x-twitter-bot.svg)](https://www.npmjs.com/package/x-twitter-bot)
[![license](https://img.shields.io/npm/l/x-twitter-bot.svg)](LICENSE)

> **Keywords:** twitter bot nodejs, x.com automation, puppeteer twitter scraper, tweet scraper node, twitter automation library, x-twitter-bot npm, post tweet nodejs, scrape twitter comments nodejs

## Install

```bash
npm install x-twitter-bot
```

## Quick Start

```js
const TwitterBot = require("x-twitter-bot");

const bot = new TwitterBot({
  cookies: {
    auth_token: "...",
    ct0: "...",
    twid: "...",
    kdt: "...",
    att: "...",
  },
  username: "your_username",
  headless: true,
});

bot.on("browserLaunched", () => console.log("Browser launched"));

bot.on("ready", async () => {
  // 1. Post a tweet
  try {
    const tweet = await bot.postTweet("Hello world! 🤖");
    console.log(tweet);
  } catch (err) {
    console.error(err.message); // e.g. "Whoops! You already said that."
  }

  // 2. Tweet stats + initial visible replies (no scroll)
  const stats = await bot.getTweetStats("TWEET_ID");
  console.log(stats.likes, stats.views, stats.initialReplies);

  // 3. Comments with auto-scroll (up to 20)
  const comments = await bot.getTweetComments("TWEET_ID", 20);
  console.log(comments.collected, comments.scrollBlocked);

  // 4. Sub-replies — pass a comment's tweetId (works recursively)
  const sub = await bot.getTweetComments(comments.comments[0].tweetId, 5);

  // 5. Search & like
  await bot.searchAndLike("nodejs", 3);

  await bot.close();
});

bot.on("loginRequired", () => { console.error("Cookies expired!"); bot.close(); });
bot.on("tweetPosted", (d) => console.log("Posted:", d.text));
bot.on("tweetFailed", (d) => console.error("Failed:", d.error));
bot.on("error", (err) => { console.error(err.message); bot.close(); });
bot.on("closed", () => console.log("Closed"));

bot.init();
```

See [example.js](example.js) for a full runnable example.

---

## Constructor

```js
new TwitterBot(options)
```

| Option | Type | Default | Description |
|---|---|---|---|
| `cookies` | `object` | **required** | Auth cookies (see below) |
| `username` | `string` | `""` | Twitter username — used for building tweet URLs |
| `headless` | `boolean` | `true` | Run browser in headless mode |
| `timeout` | `number` | `60000` | Navigation timeout (ms) |

### Required Cookies

| Cookie | Description |
|---|---|
| `auth_token` | Session auth token |
| `ct0` | CSRF token |
| `twid` | Twitter user ID |
| `kdt` | Key derivation token |
| `att` | Access token |

Optional: `guest_id`

Get these from DevTools → Application → Cookies → `https://x.com`.

---

## Events

| Event | Payload | Description |
|---|---|---|
| `browserLaunched` | – | Browser instance started |
| `ready` | – | Authenticated and ready to use |
| `loginRequired` | – | Cookies invalid/expired |
| `tweetPosted` | `{ text, timestamp }` | Tweet posted successfully |
| `tweetFailed` | `{ text, error }` | Tweet post failed |
| `error` | `Error` | Unrecoverable error during init |
| `closed` | – | Browser closed |

### Flow

```
bot.init()
    │
    ├─ emit('browserLaunched')
    │
    ├─ cookies valid? ──YES──→ emit('ready')         ← call methods here
    │                  └─NO──→ emit('loginRequired')
    │
    └─ exception ────────────→ emit('error', err)
```

---

## Methods

All methods require `ready` to have fired.

---

### `bot.init()`

Launches browser, injects cookies, navigates to `/home`, verifies authentication.

```js
bot.init(); // triggers 'ready' or 'loginRequired'
```

---

### `bot.postTweet(text)`

Posts a tweet (max 280 chars). After clicking post, checks for X error toasts (e.g. duplicate tweet warning) before returning. Handles "Leave site?" dialogs automatically. Emits `tweetPosted` on success, `tweetFailed` on failure.

```js
const result = await bot.postTweet("Hello! 🚀");
// { success: true, text: "Hello! 🚀", timestamp: "2026-02-21T12:00:00.000Z" }
```

Errors are thrown and also emitted via `tweetFailed`:
- `"Whoops! You already said that."` — duplicate tweet
- `"Tweet textarea not found"` — compose page failed to load
- `"Post button not found"` — UI issue

---

### `bot.getTweetStats(tweetId)`

Scrapes stats for a tweet **and** the initial visible replies already rendered on the page (no scrolling).

```js
const stats = await bot.getTweetStats("1893023456789");
```

**Response:**
```js
{
  id: "1893023456789",
  url: "https://x.com/username/status/1893023456789",
  text: "Tweet content here",
  likes: 42,
  replies: 7,
  reposts: 3,
  views: 1500,
  bookmarks: 2,
  initialReplies: [
    {
      tweetId: "1893024000000",
      username: "John Doe",
      handle: "@johndoe",
      text: "Great tweet!",
      time: "2026-02-21T10:00:00.000Z",
      likes: 5,
      replies: 1,
      reposts: 0
    }
  ]
}
```

Each item in `initialReplies` includes a `tweetId` you can use with `getTweetComments()`.

---

### `bot.getTweetComments(tweetId, count?)`

Scrapes comments with **automatic scrolling** until `count` is reached or scrolling is blocked.

| Param | Type | Default | Description |
|---|---|---|---|
| `tweetId` | `string` | required | Tweet ID |
| `count` | `number` | `20` | Max comments to collect |

- Caps `count` to the actual reply count shown on the page
- Stops and returns partial results if X blocks scrolling (rate limiting)

```js
const data = await bot.getTweetComments("1893023456789", 10);
```

**Response:**
```js
{
  id: "1893023456789",
  url: "https://x.com/username/status/1893023456789",
  requested: 10,
  actualReplyCount: 47,
  collected: 10,
  scrollBlocked: false,
  comments: [
    {
      tweetId: "1893024000000",
      username: "John Doe",
      handle: "@johndoe",
      text: "Nice!",
      time: "2026-02-21T10:00:00.000Z",
      likes: 3,
      replies: 0,
      reposts: 1
    }
  ]
}
```

#### Sub-replies

Every reply on X is itself a tweet. Pass any comment's `tweetId` back into `getTweetComments()` to fetch its replies:

```js
const comments = await bot.getTweetComments("1893023456789", 10);
const subReplies = await bot.getTweetComments(comments.comments[0].tweetId, 5);
```

Works recursively — you can traverse entire conversation threads.

---

### `bot.searchAndLike(query, count?)`

Searches for tweets matching a query and likes them. `count` defaults to `5`.

```js
const result = await bot.searchAndLike("nodejs", 5);
// { query: "nodejs", liked: 5 }
```

---

### `bot.close()`

Closes the browser. Emits `closed`.

```js
await bot.close();
```

---

## Project Structure

```
x-bot/
├── index.js      ← TwitterBot class (library entry point)
├── example.js    ← Full usage example
├── package.json
└── README.md
```

---

## ⚠️ Disclaimer

> **This project is NOT affiliated with, endorsed by, or associated with X (formerly Twitter) in any way.**

- This is an **unofficial**, independently developed tool created strictly for **educational and research purposes**.
- Using this library may result in your X/Twitter account being **temporarily or permanently suspended**. Automated interactions violate the [X Terms of Service](https://twitter.com/en/tos) and [X Automation Rules](https://help.twitter.com/en/rules-and-policies/x-automation).
- The author(s) of this project **accept no responsibility** for any consequences arising from the use of this software, including but not limited to account bans, data loss, or legal action.
- **You use this software entirely at your own risk.** By using it, you acknowledge that you are solely responsible for any outcomes.
- This project is provided **"as is"** without warranty of any kind, express or implied.

**If you don't fully understand the risks, do not use this library.**
