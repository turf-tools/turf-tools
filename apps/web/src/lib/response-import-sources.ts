import { S2W_PHONEBANK_SOURCE_TYPE, S2W_TEXTBANK_SOURCE_TYPE } from "~/lib/s2w-import";
import { VAN_SOURCE_TYPE } from "~/lib/van-import";

/** One supported survey-response import format. Add entries as parsers ship. */
export type ResponseImportSource = {
  /** Matches `question_external_ids.source_type` / `imported_responses.source_type`. */
  id: string;
  label: string;
  /** Short blurb shown in the system picker. */
  description: string;
  /** Primary results file label in the upload UI. */
  surveyLabel: string;
  /** Accept attribute for the results file input. */
  surveyAccept: string;
};

export const RESPONSE_IMPORT_SOURCES: readonly ResponseImportSource[] = [
  {
    id: VAN_SOURCE_TYPE,
    label: "VAN",
    description: "Standard Text ID map (StateFileID ↔ VANID) plus a Survey Responses List export.",
    surveyLabel: "Survey results",
    surveyAccept: ".xls,.txt,.tsv,.csv,text/plain",
  },
  {
    id: S2W_PHONEBANK_SOURCE_TYPE,
    label: "ScaleToWin phonebank",
    description:
      "Standard Text ID map plus a ScaleToWin phonebank CSV (Contact VanID + question columns).",
    surveyLabel: "Phonebank CSV",
    surveyAccept: ".csv,text/csv,text/plain",
  },
  {
    id: S2W_TEXTBANK_SOURCE_TYPE,
    label: "ScaleToWin textbank",
    description:
      "Standard Text ID map plus a ScaleToWin textbank CSV (van_id + Tag columns). Dates use import time.",
    surveyLabel: "Textbank CSV",
    surveyAccept: ".csv,text/csv,text/plain",
  },
] as const;

export type ResponseImportSourceId = (typeof RESPONSE_IMPORT_SOURCES)[number]["id"];

export function responseImportSource(id: string): ResponseImportSource | undefined {
  return RESPONSE_IMPORT_SOURCES.find((s) => s.id === id);
}
