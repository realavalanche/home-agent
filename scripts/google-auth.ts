import "dotenv/config";

/**
 * Prints the one-time Google consent URLs for both users. Each person opens
 * their link, signs into THEIR Google account, and grants access. The app's
 * /oauth/google/callback stores their refresh token. The server must be running
 * and reachable at PUBLIC_BASE_URL for the callback to complete.
 */
const base = process.env.PUBLIC_BASE_URL;
if (!base) throw new Error("PUBLIC_BASE_URL not set");

console.log("\nAsk each user to open their own link and sign into their own Google account:\n");
console.log(`  ${process.env.USER_A_NAME ?? "User A"}:  ${base}/oauth/google/start?user=A`);
console.log(`  ${process.env.USER_B_NAME ?? "User B"}:  ${base}/oauth/google/start?user=B`);
console.log("\nAfter each sees the success page, calendar + gmail tools are live for them.\n");
