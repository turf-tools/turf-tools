import { type PersonSummary, isRecorded } from "@/lib/canvass-events";
import type { TurfIndexes } from "@/lib/turf-data";

// Labels for every outcome a result event can carry. The native UI only
// offers a subset, but events from other clients can carry the rest.
const OUTCOME_LABELS: Record<string, string> = {
  canvassed: "Canvassed",
  not_home: "Not home",
  deceased: "Deceased",
  hostile: "Hostile",
  moved: "Moved",
  address_not_found: "Address not found",
  inaccessible: "Inaccessible",
};

export type TurfProgress = {
  // Headline number: people marked / total, 0-100.
  percent: number;
  // `contacted` (canvassed) vs the rest of `done` drives the two ring segments.
  people: { done: number; total: number; contacted: number };
  doors: { done: number; total: number };
  // Nonzero outcome tallies in display order; percent is the share of
  // marked people, so the breakdown sums to ~100%.
  outcomes: Array<{ value: string; label: string; count: number; percent: number }>;
};

export function deriveTurfProgress(
  indexes: TurfIndexes,
  summaries: Map<string, PersonSummary>,
): TurfProgress {
  const persons = indexes.personsInOrder;
  const peopleDone = persons.filter((p) => isRecorded(summaries, p.personId)).length;

  // A door is done when every resident is marked — same rule as the
  // building-complete alerts. Doors with no residents can't be recorded
  // against, so they're excluded from the denominator.
  let doorsDone = 0;
  let doorsTotal = 0;
  for (const door of indexes.doorsById.values()) {
    if (door.persons.length === 0) continue;
    doorsTotal += 1;
    if (door.persons.every((p) => isRecorded(summaries, p.personId))) doorsDone += 1;
  }

  // The summary collapses outcome "canvassed" to null, so a person with
  // no unavailable outcome but recorded responses counts as canvassed.
  const counts = new Map<string, number>();
  for (const person of persons) {
    const summary = summaries.get(person.personId);
    if (!summary) continue;
    const outcome =
      summary.currentOutcome ?? (summary.responsesByQuestion.size > 0 ? "canvassed" : null);
    if (!outcome) continue;
    counts.set(outcome, (counts.get(outcome) ?? 0) + 1);
  }
  const known = Object.keys(OUTCOME_LABELS);
  const outcomes = [...counts.keys()]
    .sort((a, b) => {
      const ai = known.indexOf(a);
      const bi = known.indexOf(b);
      return (ai === -1 ? known.length : ai) - (bi === -1 ? known.length : bi);
    })
    .map((value) => ({
      value,
      label: OUTCOME_LABELS[value] ?? value,
      count: counts.get(value)!,
      percent: peopleDone > 0 ? Math.round((100 * counts.get(value)!) / peopleDone) : 0,
    }));

  return {
    percent:
      persons.length > 0 ? Math.min(100, Math.round((100 * peopleDone) / persons.length)) : 0,
    people: { done: peopleDone, total: persons.length, contacted: counts.get("canvassed") ?? 0 },
    doors: { done: doorsDone, total: doorsTotal },
    outcomes,
  };
}

// Minimal structural view of the script payload — mirrors ScriptStepLike
// on the person screen rather than importing server types.
type ScriptStep = {
  stepType: string;
  questionId?: string;
  responseType?: string;
  text: string;
  options?: Array<{ responseOptionId: string; text: string }>;
};

export type QuestionTally = {
  questionId: string;
  text: string;
  // People with a stored response for this question.
  answered: number;
  // Percent is the share of answerers; multi-selects can sum past 100.
  options: Array<{ responseOptionId: string; text: string; count: number; percent: number }>;
};

// Tally selections per option for each question step, in script order.
// Open-ended questions are skipped — free text has no useful aggregate.
// The current script is the only source of labels, so a person counts as
// an answerer only when at least one of their selections is a current
// option — answers referencing only archived options drop out of both
// numerator and denominator, keeping percentages a share of what's shown.
export function deriveResponseTallies(
  steps: ScriptStep[],
  summaries: Map<string, PersonSummary>,
): QuestionTally[] {
  const tallies: QuestionTally[] = [];
  for (const step of steps) {
    if (step.stepType !== "question" || !step.questionId) continue;
    if (step.responseType === "open_ended") continue;
    const validIds = new Set((step.options ?? []).map((o) => o.responseOptionId));
    let answered = 0;
    const counts = new Map<string, number>();
    for (const summary of summaries.values()) {
      const response = summary.responsesByQuestion.get(step.questionId);
      if (!response || !("optionIds" in response)) continue;
      const chosen = response.optionIds.filter((id) => validIds.has(id));
      if (chosen.length === 0) continue;
      answered += 1;
      for (const id of chosen) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    tallies.push({
      questionId: step.questionId,
      text: step.text,
      answered,
      options: (step.options ?? []).map((option) => {
        const count = counts.get(option.responseOptionId) ?? 0;
        return {
          responseOptionId: option.responseOptionId,
          text: option.text,
          count,
          percent: answered > 0 ? Math.round((100 * count) / answered) : 0,
        };
      }),
    });
  }
  return tallies;
}
