import { VAN_SOURCE_TYPE } from "~/lib/van-import";

/** One supported survey-response import format. Add entries as parsers ship. */
export type ResponseImportSource = {
  /** Matches `question_external_ids.source_type` / `imported_responses.source_type`. */
  id: string;
  label: string;
  /** Short blurb shown in the system picker. */
  description: string;
};

export const RESPONSE_IMPORT_SOURCES: readonly ResponseImportSource[] = [
  {
    id: VAN_SOURCE_TYPE,
    label: "VAN",
    description: "Standard Text ID map (StateFileID ↔ VANID) plus a Survey Responses List export.",
  },
] as const;

export type ResponseImportSourceId = (typeof RESPONSE_IMPORT_SOURCES)[number]["id"];

export function responseImportSource(id: string): ResponseImportSource | undefined {
  return RESPONSE_IMPORT_SOURCES.find((s) => s.id === id);
}
