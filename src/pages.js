// Public Terms of Service and Privacy Policy, served by the Worker at /terms and /privacy
// (the URLs to give the Discord developer portal). terms.html and privacy.html in the repo
// root are copies; test/pages.test.mjs keeps them identical.

const CONTACT = "https://github.com/MehdiHALA/UnemploymentMasters/issues";
const UPDATED = "1 November 2026";

function page(title, body) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · PSN Trophy Bot</title>
<style>
  body { font: 16px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif; max-width: 720px; margin: 40px auto; padding: 0 20px; color: #1f2328; }
  h1 { font-size: 28px; margin-bottom: 4px; }
  h2 { font-size: 18px; margin-top: 28px; }
  .updated { color: #59636e; margin-top: 0; }
  a { color: #0969da; }
</style>
</head>
<body>
<h1>${title}</h1>
<p class="updated">PSN Trophy Bot · last updated ${UPDATED}</p>
${body}
</body>
</html>
`;
}

export const TERMS_HTML = page(
  "Terms of Service",
  `<p>PSN Trophy Bot ("the bot") shows PlayStation trophy leaderboards inside Discord servers. By adding the bot to a server or using its commands, you agree to these terms.</p>

<h2>Using the bot</h2>
<ul>
<li>Follow Discord's Terms of Service and Community Guidelines when you use the bot.</li>
<li>Only link PlayStation Network accounts that are yours, or that you are allowed to link. Moderators who link accounts for members are responsible for having their permission.</li>
<li>Don't try to overload or disrupt the bot, get around its limits, or use it to harass anyone.</li>
</ul>

<h2>Trophy data</h2>
<p>The bot reads public trophy information from PlayStation Network. It can be delayed, incomplete or wrong, and depends on each player's PSN privacy settings. The bot is not affiliated with or endorsed by Sony Interactive Entertainment or Discord.</p>

<h2>Platinum</h2>
<p>Platinum is an optional paid tier for a whole server. It is sold as a monthly subscription through Discord: Discord handles payment, renewal, cancellation and refunds under its own terms, and the bot never sees payment details. After a cancellation, Platinum stays active until the end of the paid period. Free Platinum given by the bot's developer, for example as a promotion, lasts for the period stated when it is given. Platinum features may change over time.</p>

<h2>Availability</h2>
<p>The bot is provided as is, without warranties. It may be unavailable at times, and features may change or end.</p>

<h2>Liability</h2>
<p>To the extent the law allows, the bot's developer is not liable for indirect or consequential losses from using the bot. Nothing in these terms limits rights you have under the consumer laws where you live.</p>

<h2>Ending</h2>
<p>You can remove the bot from your server or unlink your accounts with /removepsn at any time. Access can be removed from servers or users who break these terms.</p>

<h2>Changes and contact</h2>
<p>These terms may be updated; the date above shows the current version. Questions: <a href="${CONTACT}">open an issue on GitHub</a> or use /support. See also the <a href="/privacy">Privacy Policy</a>.</p>`
);

export const PRIVACY_HTML = page(
  "Privacy Policy",
  `<h2>What the bot stores</h2>
<ul>
<li>Your Discord user ID and the server ID where you linked a PSN account.</li>
<li>The PSN Online ID and account ID you linked, and that account's public trophy statistics, avatar and recently played games.</li>
<li>Which platinum trophies were announced.</li>
<li>Server settings chosen by server admins: channels, colours, trophy emojis, the weekly post time and roles.</li>
<li>The names and member counts of the servers the bot is in, used only for the developer's admin tools.</li>
</ul>

<h2>In servers with Platinum, also</h2>
<ul>
<li>A daily record of trophy totals for linked accounts, kept for 90 days.</li>
<li>Race entries and progress, deleted 90 days after a race ends.</li>
<li>Monthly starting totals for the monthly standings, replaced each month.</li>
<li>Which milestone roles the bot gave to members.</li>
</ul>

<h2>How long</h2>
<p>Accounts looked up with /platinums or /compare without being linked are kept for up to 30 days. Use /removepsn to unlink an account; it then stops being updated, and once it is linked in no server its trophy data is deleted within 30 days.</p>

<h2>Payments</h2>
<p>Platinum purchases are handled by Discord. The bot only learns whether a server has an active Platinum subscription, never payment details.</p>

<h2>Sharing</h2>
<p>Data is not sold or shared. Trophy data is only read from PlayStation Network's public trophy information. This bot is not affiliated with Sony Interactive Entertainment.</p>

<h2>Contact</h2>
<p>Questions or deletion requests: <a href="${CONTACT}">open an issue on GitHub</a> or use /support. See also the <a href="/terms">Terms of Service</a>.</p>`
);

export const PAGES = {
  "/terms": TERMS_HTML,
  "/privacy": PRIVACY_HTML,
};
