import "dotenv/config";
import crypto from "node:crypto";

/**
 * Send a signed fake inbound text message to the local webhook, exactly as Meta
 * would, so you can test the full pipeline without WhatsApp. Usage:
 *   npm run test:webhook -- "buy milk and eggs tomorrow"
 * The sender defaults to USER_A_WHATSAPP (change with SENDER=...).
 */
const port = process.env.PORT ?? "8080";
const secret = process.env.WHATSAPP_APP_SECRET ?? "";
const from = process.env.SENDER ?? process.env.USER_A_WHATSAPP ?? "919999999999";
const bodyText = process.argv.slice(2).join(" ") || "Idea: build a home assistant on WhatsApp";

const payload = {
  object: "whatsapp_business_account",
  entry: [
    {
      changes: [
        {
          value: {
            messages: [
              {
                id: `wamid.test.${Date.now()}`,
                from,
                timestamp: String(Math.floor(Date.now() / 1000)),
                type: "text",
                text: { body: bodyText },
              },
            ],
          },
        },
      ],
    },
  ],
};

const raw = Buffer.from(JSON.stringify(payload));
const sig = "sha256=" + crypto.createHmac("sha256", secret).update(raw).digest("hex");

const res = await fetch(`http://localhost:${port}/webhook`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-hub-signature-256": sig },
  body: raw,
});
console.log("status:", res.status, await res.text());
console.log(`sent as ${from}: "${bodyText}"`);
