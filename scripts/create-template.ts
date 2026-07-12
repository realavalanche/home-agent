import "dotenv/config";

/**
 * Submit the "check-in" WhatsApp template to Meta for approval. Run once:
 *   npm run setup:template
 *
 * Why it exists: WhatsApp only allows free-form messages within 24 hours of the
 * user's last message. If neither of you has messaged the assistant in a day,
 * the morning briefing / meal check-in can't reach you. An APPROVED template can
 * be sent any time — so we send this friendly ping, and the moment you reply the
 * window reopens and everything flows normally again.
 */
const waba = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID;
const token = process.env.WHATSAPP_ACCESS_TOKEN;
const version = process.env.WHATSAPP_GRAPH_VERSION ?? "v21.0";
const name = process.env.WHATSAPP_CHECKIN_TEMPLATE ?? "checkin_ping";
const lang = process.env.WHATSAPP_TEMPLATE_LANG ?? "en";

if (!waba) throw new Error("WHATSAPP_BUSINESS_ACCOUNT_ID not set");
if (!token) throw new Error("WHATSAPP_ACCESS_TOKEN not set");

const body = {
  name,
  language: lang,
  category: "MARKETING", // a friendly check-in isn't a transactional/utility notice
  components: [
    {
      type: "BODY",
      text: "Hey {{1}} 👋 Are you doing ok? Just wanted to check in :) Reply here and I'll pick up right where we left off.",
      example: { body_text: [["Sid"]] },
    },
  ],
};

const res = await fetch(`https://graph.facebook.com/${version}/${waba}/message_templates`, {
  method: "POST",
  headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

const json = await res.json();
if (!res.ok) {
  console.error("❌ Template submission failed:\n", JSON.stringify(json, null, 2));
  process.exit(1);
}
console.log("✓ Template submitted for approval:", JSON.stringify(json, null, 2));
console.log(`\nName: ${name} (${lang})`);
console.log("Check status in WhatsApp Manager → Message Templates. Approval is usually minutes.");
console.log("Once APPROVED, nothing else to do — the app uses it automatically.");
