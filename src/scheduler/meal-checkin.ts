import { DateTime } from "luxon";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { allUsers, getUser, type AuthorKey } from "../users.js";
import { getMealPlan, isSettled, describePlan } from "../meals.js";
import { sendText } from "../whatsapp/client.js";

/**
 * Daily 3pm check-in for TOMORROW's meals.
 *  - Already settled (breakfast + lunch, both agreed) → stay quiet.
 *  - One partner proposed but the other hasn't agreed → ask only that partner to confirm.
 *  - Nothing planned → ask both.
 * Dinner is assumed to be the same as lunch unless stated.
 */
export async function runMealCheckin(): Promise<void> {
  const tomorrow = DateTime.now().setZone(config.TIMEZONE).plus({ days: 1 });
  const dateISO = tomorrow.toISODate()!;
  const pretty = tomorrow.toFormat("cccc, dd LLL");

  const plan = await getMealPlan(dateISO);

  // 1) Fully settled — nothing to ask.
  if (isSettled(plan)) {
    logger.info("meal check-in: already settled", { dateISO });
    return;
  }

  // 2) Proposed by one partner — ask ONLY the other to confirm.
  if (plan?.proposedBy && (plan.breakfast || plan.lunch)) {
    const proposer = getUser(plan.proposedBy);
    const other = allUsers().find((u) => u.key !== plan.proposedBy);
    if (other) {
      await sendText(
        other.whatsapp,
        `🍽️ ${proposer.name} has planned tomorrow (${pretty}):\n${describePlan(plan)}\n\nWorks for you? Reply "ok" to confirm, or suggest a change.`
      );
      logger.info("meal check-in: asked partner to confirm", { dateISO, asked: other.key });
    }
    return;
  }

  // 3) Nothing planned — ask both.
  for (const user of allUsers()) {
    await sendText(
      user.whatsapp,
      `🍽️ What's the plan for tomorrow (${pretty})?\nBreakfast? And the lunch sabzi? (I'll assume dinner is the same as lunch unless you say otherwise.)`
    );
  }
  logger.info("meal check-in: asked both", { dateISO });
}

/** Notify the partner that a plan was proposed, so they can agree. */
export async function notifyPartnerOfPlan(
  proposedBy: AuthorKey,
  dateISO: string
): Promise<void> {
  const plan = await getMealPlan(dateISO);
  if (!plan) return;
  const other = allUsers().find((u) => u.key !== proposedBy);
  if (!other) return;
  const proposer = getUser(proposedBy);
  const when = DateTime.fromISO(dateISO, { zone: config.TIMEZONE }).toFormat("cccc, dd LLL");
  await sendText(
    other.whatsapp,
    `🍽️ ${proposer.name} planned meals for ${when}:\n${describePlan(plan)}\n\nOk with you? Reply "ok" to confirm, or suggest a change.`
  );
}
