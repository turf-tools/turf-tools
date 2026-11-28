import type { Db } from "@turf-tools/db";
import {
  runSurveyResponseImport,
  type ResponseImportBuffers,
  type SurveyQuestionMapping,
} from "~/lib/server/response-import-run";
import type { ResponseImportStats } from "~/lib/survey-import";
import { parseVanSurveyExportBytes, VAN_SOURCE_TYPE } from "~/lib/van-import";

export type { SurveyQuestionMapping };

export async function runVanResponseImport(
  db: Db,
  opts: ResponseImportBuffers,
): Promise<ResponseImportStats> {
  const survey = parseVanSurveyExportBytes(opts.surveyBuffer);
  return runSurveyResponseImport(db, {
    ...opts,
    sourceType: VAN_SOURCE_TYPE,
    survey,
  });
}
