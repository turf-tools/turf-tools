// Report wire contract shared by the server RPC, the client queries, and
// the page. Lives here (import-free) so client code can use the values
// without dragging server-only modules into the browser bundle.

export const REPORT_KINDS = ["people", "attempts", "responses", "walks", "canvassers"] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];

// Accounting of the extract itself (never population analysis — that's
// Results). Fields are per-kind: people/questions on responses,
// people/outcomes on attempts, contacted/outcomes on people, the
// canvasser/walk sums on walks and canvassers.
export type ReportSummary = {
  people?: number;
  questions?: { label: string; count: number }[];
  outcomes?: Record<string, number>;
  canvassers?: number;
  walks?: number;
  turfs?: number;
  attempts?: number;
  contacts?: number;
};

export type ReportRows = {
  // Ordered column labels; question columns carry the question name.
  columns: string[];
  // Preview page of cell values in column order.
  rows: (string | number | null)[][];
  total: number;
  // Distinct canvass days in the campaign scope, ignoring the day
  // filter — the date chip's options.
  days: string[];
  summary: ReportSummary;
  // Which column labels are generated question columns.
  questionColumns: string[];
};
