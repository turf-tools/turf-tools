import type { Db } from "@turf-tools/db";
import {
  runSurveyResponseImport,
  type ResponseImportBuffers,
} from "~/lib/server/response-import-run";
import {
  parseS2wPhonebankBytes,
  parseS2wTextbankBytes,
  S2W_PHONEBANK_SOURCE_TYPE,
  S2W_TEXTBANK_SOURCE_TYPE,
} from "~/lib/s2w-import";
import type { ResponseImportStats } from "~/lib/survey-import";

export async function runS2wPhonebankImport(
  db: Db,
  opts: ResponseImportBuffers,
): Promise<ResponseImportStats> {
  const survey = parseS2wPhonebankBytes(opts.surveyBuffer);
  return runSurveyResponseImport(db, {
    ...opts,
    sourceType: S2W_PHONEBANK_SOURCE_TYPE,
    survey,
  });
}

export async function runS2wTextbankImport(
  db: Db,
  opts: ResponseImportBuffers,
): Promise<ResponseImportStats> {
  // Textbank exports have no contact datetime — stamp this import's clock.
  const survey = parseS2wTextbankBytes(opts.surveyBuffer, new Date());
  return runSurveyResponseImport(db, {
    ...opts,
    sourceType: S2W_TEXTBANK_SOURCE_TYPE,
    survey,
  });
}
