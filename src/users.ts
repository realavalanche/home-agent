import { config, normalizePhone } from "./config.js";

/**
 * The two known users. Identity is keyed off the sender's WhatsApp number.
 * Anyone else is `undefined` → the caller sends a polite rejection and does no
 * processing (requirement 14).
 */
export type AuthorKey = "A" | "B";

export interface User {
  key: AuthorKey;
  name: string;
  whatsapp: string; // normalized digits
  googleEmail?: string;
}

const USERS: Record<AuthorKey, User> = {
  A: {
    key: "A",
    name: config.USER_A_NAME,
    whatsapp: normalizePhone(config.USER_A_WHATSAPP),
    googleEmail: config.USER_A_GOOGLE_EMAIL,
  },
  B: {
    key: "B",
    name: config.USER_B_NAME,
    whatsapp: normalizePhone(config.USER_B_WHATSAPP),
    googleEmail: config.USER_B_GOOGLE_EMAIL,
  },
};

/** Look up a user by inbound WhatsApp sender number. */
export function identifyUser(fromPhone: string): User | undefined {
  const from = normalizePhone(fromPhone);
  return Object.values(USERS).find((u) => u.whatsapp === from);
}

export function getUser(key: AuthorKey): User {
  return USERS[key];
}

export function allUsers(): User[] {
  return Object.values(USERS);
}
