/** Shared survey-response import shapes used by every source parser. */

export type SurveyImportAnswer = {
  /** Person key for the ID-map join (VANID in every format today). */
  personVanId: string;
  questionExternalId: string;
  responseExternalId: string;
  questionName: string;
  responseName: string;
  canvassedAt: Date;
  /** Stable dedupe key for imported_responses.source_key. */
  sourceKey: string;
};

export type SurveyQuestionPreview = {
  questionExternalId: string;
  name: string;
  answerCount: number;
  /** Response options in first-seen order. */
  responses: { responseExternalId: string; text: string; count: number }[];
  /** True when any person has >1 distinct response on the same day. */
  multiSelect: boolean;
};

export type SurveyImportRowSkip = {
  /** 1-based file line (header is line 1). */
  line: number;
  reason: "incomplete" | "bad_date";
  personVanId: string;
  questionExternalId: string;
  responseExternalId: string;
  dateRaw: string;
};

export type SurveyImportParse = {
  ok: boolean;
  missingColumns: string[];
  rowCount: number;
  answers: SurveyImportAnswer[];
  questions: SurveyQuestionPreview[];
  rowsSkippedIncomplete: number;
  rowsSkippedBadDate: number;
  sampleSkipped: SurveyImportRowSkip[];
};

export type ResponseImportStats = {
  idMapRows: number;
  surveyRows: number;
  questionsCreated: number;
  questionsUpdated: number;
  questionsMatched: number;
  optionsCreated: number;
  peopleWritten: number;
  peopleSkippedUnmapped: number;
  peopleSkippedUnmatched: number;
  responsesInserted: number;
  responsesDeduped: number;
  sampleUnmappedVanIds: string[];
  sampleUnmatchedExternalIds: string[];
};
