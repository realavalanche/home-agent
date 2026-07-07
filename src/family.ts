import { DateTime } from "luxon";

/**
 * India childhood immunization schedule (National Immunization Schedule / IAP,
 * common milestones). This is a general guide for reminders — actual timing must
 * be confirmed with the child's pediatrician. Offsets are days from birth.
 */
interface Vaccine {
  label: string;
  offsetDays: number;
}

export const INDIA_IMMUNIZATION: Vaccine[] = [
  { label: "BCG, OPV-0, Hepatitis B (birth)", offsetDays: 0 },
  { label: "Pentavalent-1, OPV-1, IPV-1, Rotavirus-1, PCV-1 (6 weeks)", offsetDays: 42 },
  { label: "Pentavalent-2, OPV-2, Rotavirus-2 (10 weeks)", offsetDays: 70 },
  { label: "Pentavalent-3, OPV-3, IPV-2, Rotavirus-3, PCV-2 (14 weeks)", offsetDays: 98 },
  { label: "Measles-Rubella-1, PCV Booster, JE-1 (9 months)", offsetDays: 274 },
  { label: "DPT Booster-1, MR-2, OPV Booster, JE-2 (16–18 months)", offsetDays: 517 },
  { label: "DPT Booster-2 (5 years)", offsetDays: 1825 },
  { label: "Td / Tdap (10 years)", offsetDays: 3650 },
  { label: "Td / Tdap (16 years)", offsetDays: 5840 },
];

export interface ScheduledVaccine {
  label: string;
  dueISODate: string; // yyyy-mm-dd
  dueDateTimeISO: string; // due date at 09:00 in tz
}

/** Compute each vaccine's due date from the child's date of birth. */
export function buildImmunizationSchedule(dobISO: string, tz: string): ScheduledVaccine[] {
  const dob = DateTime.fromISO(dobISO, { zone: tz });
  return INDIA_IMMUNIZATION.map((v) => {
    const due = dob.plus({ days: v.offsetDays }).set({ hour: 9, minute: 0, second: 0 });
    return {
      label: v.label,
      dueISODate: due.toISODate()!,
      dueDateTimeISO: due.toISO()!,
    };
  });
}
