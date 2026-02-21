const TwitterBot = require("x-twitter-bot");

const bot = new TwitterBot({
  cookies: {
    auth_token: "YOUR_AUTH_TOKEN",
    ct0: "YOUR_CT0_TOKEN",
    twid: "u%3DYOUR_USER_ID",
    kdt: "YOUR_KDT_TOKEN",
    att: "YOUR_ATT_TOKEN"
  },
  username: "your_username",
  headless: false,
});

// ── Events ──────────────────────────────────────────────────

bot.on("browserLaunched", () => console.log("🌐 Browser launched"));

bot.on("ready", async () => {
  console.log("✅ Bot is ready!\n");

  // 1. Post a tweet
  try {
    const tweet = await bot.postTweet("Hello from x-bot! 🤖");
    console.log("✅ Tweet posted:", tweet);
  } catch (err) {
    console.error("❌ Tweet failed:", err.message);
  }

  // 2. Get tweet stats (+ initial visible replies)
  const stats = await bot.getTweetStats("TWEET_ID_HERE");
  console.log("\n📊 Stats:", { likes: stats.likes, replies: stats.replies, reposts: stats.reposts, views: stats.views });
  console.log(`📋 Initial replies (${stats.initialReplies.length}):`); 
  for (const r of stats.initialReplies) {
    console.log(`  [${r.tweetId}] @${r.handle}: ${r.text.slice(0, 80)}`);
  }

  // 3. Get comments with count limit (auto-scroll)
  const comments = await bot.getTweetComments("TWEET_ID_HERE", 10);
  console.log(`\n💬 Comments: ${comments.collected}/${comments.requested}${comments.scrollBlocked ? " (scroll blocked)" : ""}`);
  for (const c of comments.comments) {
    console.log(`  [${c.tweetId}] @${c.handle}: ${c.text.slice(0, 80)}`);
  }

  // 4. Sub-replies (replies to a reply — same method, pass the comment's tweetId)
  const subReplies = await bot.getTweetComments("REPLY_TWEET_ID_HERE", 5);
  console.log(`\n🔁 Sub-replies: ${subReplies.collected}`);
  for (const c of subReplies.comments) {
    console.log(`  [${c.tweetId}] @${c.handle}: ${c.text.slice(0, 80)}`);
  }

  // 5. Search & like
  const liked = await bot.searchAndLike("nodejs", 3);
  console.log(`\n❤️  Liked ${liked.liked} tweets for "${liked.query}"`);

  await bot.close();
});

bot.on("loginRequired", () => {
  console.error("❌ Cookies expired. Provide fresh cookies.");
  bot.close();
});

bot.on("tweetPosted", (d) => console.log("📢 tweetPosted →", d.text));
bot.on("tweetFailed", (d) => console.error("💥 tweetFailed →", d.error));
bot.on("error", (err) => { console.error("🔥 Error:", err.message); bot.close(); });
bot.on("closed", () => console.log("👋 Closed"));

// ── Start ───────────────────────────────────────────────────
bot.init();
