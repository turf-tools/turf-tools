// Benchmark scenarios: criteria shapes chosen to span the dimensions that
// drive query cost — selectivity (2M vs 10k results), step count, verb mix
// (add disables the cascade's WHERE pushdown), and filters that resolve
// against operational data (canvass) or voting history. Field keys/values
// are the NYS voter file vocabulary, so scenarios run unchanged against any
// environment with that dataset. Custom-field filters reference per-dataset
// ids, so those arrive via --extra <file.json> instead.

type Step = { verb: "narrow" | "add" | "remove"; filter: Record<string, unknown> };
export type Criteria = { steps: Step[] };

export type Scenario = {
  name: string;
  description: string;
  criteria: Criteria;
  // Fire all endpoints concurrently (per iteration) instead of sequentially —
  // measures the data server's event-loop serialization under the segment
  // editor's real request pattern.
  burst?: boolean;
};

const narrow = (filter: Record<string, unknown>): Step => ({ verb: "narrow", filter });

const zip = (...values: string[]) => ({ kind: "text-multi", key: "zip5", values });
const gender = (...values: string[]) => ({ kind: "enum", key: "gender", values });
const party = (...values: string[]) => ({ kind: "enum", key: "enrollment", values });

export const SCENARIOS: Scenario[] = [
  {
    name: "empty",
    description: "no steps — full-table counts, every building in the points payload",
    criteria: { steps: [] },
  },
  {
    name: "narrow-small",
    description: "one zip (~tens of thousands of people)",
    criteria: { steps: [narrow(zip("11226"))] },
  },
  {
    name: "narrow-large",
    description: "gender F (~half the file)",
    criteria: { steps: [narrow(gender("F"))] },
  },
  {
    name: "steps-narrow",
    description: "three stacked narrows (cascade pushdown-eligible)",
    criteria: {
      steps: [narrow(zip("11226", "11215")), narrow(gender("F")), narrow(party("democratic"))],
    },
  },
  {
    name: "steps-add",
    description: "narrow, widen with add, narrow (cascade pushdown-disabled)",
    criteria: {
      steps: [
        narrow(gender("F")),
        { verb: "add", filter: party("republican") },
        narrow(zip("11226")),
      ],
    },
  },
  {
    name: "voting-history",
    description: "voted in ≥2 generals in 6 years (reads the voting_history column)",
    criteria: {
      steps: [
        narrow({
          kind: "voting-history-count",
          key: "voting_history_count",
          type: "general",
          windowYears: 6,
          comparator: "at_least",
          count: 2,
        }),
      ],
    },
  },
  // No canvass-outcome scenario: its cost tracks each environment's
  // canvass_events volume, so cross-environment cells aren't comparable —
  // unlike the rest of the battery, which only assumes the same voter file.
  // Reinstate with a seeded, identical events fixture if we want it back.
  {
    name: "burst",
    description: "steps-narrow criteria, all endpoints fired concurrently",
    criteria: {
      steps: [narrow(zip("11226", "11215")), narrow(gender("F")), narrow(party("democratic"))],
    },
    burst: true,
  },
];
