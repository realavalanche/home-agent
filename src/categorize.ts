/** The fixed capture taxonomy (requirement 4). Shared by the agent prompt,
 * the Notion schema (select options), and the weekly review. */
export const CATEGORIES = [
  "Shopping",
  "Meals",
  "Ideas",
  "Work",
  "Personal",
  "Family",
  "Tasks",
] as const;
export type Category = (typeof CATEGORIES)[number];

export const MEAL_SUBCATEGORIES = ["Breakfast", "Lunch", "Dinner"] as const;
export type MealSubcategory = (typeof MEAL_SUBCATEGORIES)[number];

/** Human-readable rubric injected into the agent's system prompt so
 * categorization is consistent and explainable. */
export const CATEGORY_RUBRIC = `
- Shopping: things to buy, groceries, wishlists, price/product notes.
- Meals: anything about food eaten or planned. Set subcategory Breakfast/Lunch/Dinner when clear.
- Ideas: thoughts, plans, business/creative ideas, "what if" notes. Extract next actions from these.
- Work: job/professional tasks, meetings, projects, clients.
- Personal: personal errands, finance, self, non-family logistics.
- Family: baby (vaccinations, milestones), school, health/doctor, relatives, household.
- Tasks: an explicit to-do / action item that doesn't fit a richer category.
`.trim();
