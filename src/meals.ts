import { query } from "./db/pool.js";
import type { AuthorKey } from "./users.js";

/**
 * Shared meal planning. One partner proposes a day's meals; the other confirms.
 * Dinner defaults to lunch (they usually eat the same). The 3pm check-in only
 * asks about a date that isn't already settled.
 */

export interface MealPlan {
  planDate: string; // yyyy-mm-dd
  breakfast: string | null;
  lunch: string | null;
  dinner: string | null; // null => same as lunch
  proposedBy: AuthorKey | null;
  confirmedBy: AuthorKey | null;
  status: "proposed" | "confirmed";
}

interface Row {
  plan_date: string;
  breakfast: string | null;
  lunch: string | null;
  dinner: string | null;
  proposed_by: string | null;
  confirmed_by: string | null;
  status: string;
}

function map(r: Row): MealPlan {
  return {
    planDate: typeof r.plan_date === "string" ? r.plan_date.slice(0, 10) : new Date(r.plan_date).toISOString().slice(0, 10),
    breakfast: r.breakfast,
    lunch: r.lunch,
    dinner: r.dinner,
    proposedBy: (r.proposed_by as AuthorKey) ?? null,
    confirmedBy: (r.confirmed_by as AuthorKey) ?? null,
    status: r.status === "confirmed" ? "confirmed" : "proposed",
  };
}

/** A plan is "settled" once breakfast + lunch are known AND the partner agreed. */
export function isSettled(plan: MealPlan | undefined): boolean {
  return Boolean(plan && plan.breakfast && plan.lunch && plan.status === "confirmed");
}

/** Human-readable summary. Dinner falls back to lunch. */
export function describePlan(plan: MealPlan): string {
  const dinner = plan.dinner ?? (plan.lunch ? `${plan.lunch} (same as lunch)` : null);
  return [
    plan.breakfast ? `Breakfast: ${plan.breakfast}` : null,
    plan.lunch ? `Lunch: ${plan.lunch}` : null,
    dinner ? `Dinner: ${dinner}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

export async function getMealPlan(dateISO: string): Promise<MealPlan | undefined> {
  const res = await query<Row>(`SELECT * FROM meal_plans WHERE plan_date = $1`, [dateISO]);
  const row = res.rows[0];
  return row ? map(row) : undefined;
}

export async function getMealPlans(fromISO: string, toISO: string): Promise<MealPlan[]> {
  const res = await query<Row>(
    `SELECT * FROM meal_plans WHERE plan_date >= $1 AND plan_date <= $2 ORDER BY plan_date`,
    [fromISO, toISO]
  );
  return res.rows.map(map);
}

/**
 * One partner proposes (or updates) a day's meals. Any change resets it to
 * 'proposed' so the other partner gets to agree.
 */
export async function proposeMealPlan(
  dateISO: string,
  by: AuthorKey,
  meals: { breakfast?: string; lunch?: string; dinner?: string }
): Promise<MealPlan> {
  const res = await query<Row>(
    `INSERT INTO meal_plans (plan_date, breakfast, lunch, dinner, proposed_by, status, updated_at)
     VALUES ($1,$2,$3,$4,$5,'proposed', now())
     ON CONFLICT (plan_date) DO UPDATE SET
       breakfast   = COALESCE($2, meal_plans.breakfast),
       lunch       = COALESCE($3, meal_plans.lunch),
       dinner      = COALESCE($4, meal_plans.dinner),
       proposed_by = $5,
       confirmed_by = NULL,
       status      = 'proposed',
       updated_at  = now()
     RETURNING *`,
    [dateISO, meals.breakfast ?? null, meals.lunch ?? null, meals.dinner ?? null, by]
  );
  return map(res.rows[0]!);
}

/** The other partner agrees — the date is now settled. */
export async function confirmMealPlan(
  dateISO: string,
  by: AuthorKey
): Promise<MealPlan | undefined> {
  const res = await query<Row>(
    `UPDATE meal_plans SET status = 'confirmed', confirmed_by = $2, updated_at = now()
     WHERE plan_date = $1 RETURNING *`,
    [dateISO, by]
  );
  const row = res.rows[0];
  return row ? map(row) : undefined;
}
