import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Callout, DialogError } from "~/components/callout";
import { Button } from "~/components/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "~/components/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/components/dropdown-menu";
import { Input } from "~/components/input";
import { questionsWithOptionsQuery } from "~/lib/queries/questions";
import {
  parseVanIdMapBytes,
  parseVanSurveyExportBytes,
  VAN_SOURCE_TYPE,
  type VanIdMapParse,
  type VanImportStats,
  type VanSurveyParse,
} from "~/lib/van-import";

type Props = {
  orgSlug: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

/** Skip, create a new question, or match an existing one. */
type QuestionChoice = { kind: "skip" } | { kind: "create" } | { kind: "match"; questionId: string };

type SelectableQuestion = {
  questionId: string;
  name: string;
  externalIds: { sourceType: string; externalId: string }[];
  options: { text: string; archived: boolean }[];
};

function vanExternalId(q: SelectableQuestion): string | undefined {
  return q.externalIds.find((e) => e.sourceType === VAN_SOURCE_TYPE)?.externalId;
}

function defaultChoicesFor(
  parsed: VanSurveyParse,
  selectable: SelectableQuestion[],
): Record<string, QuestionChoice> {
  const initial: Record<string, QuestionChoice> = {};
  const used = new Set<string>();
  for (const q of parsed.questions) {
    const byExt = selectable.find((oq) => vanExternalId(oq) === q.questionVanId);
    if (byExt && !used.has(byExt.questionId)) {
      initial[q.questionVanId] = { kind: "match", questionId: byExt.questionId };
      used.add(byExt.questionId);
      continue;
    }
    const byName = selectable.find(
      (oq) =>
        !used.has(oq.questionId) && oq.name.trim().toLowerCase() === q.name.trim().toLowerCase(),
    );
    if (byName) {
      initial[q.questionVanId] = { kind: "match", questionId: byName.questionId };
      used.add(byName.questionId);
      continue;
    }
    initial[q.questionVanId] = { kind: "create" };
  }
  return initial;
}

export function VanImportDialog({ orgSlug, open, onOpenChange }: Props) {
  const queryClient = useQueryClient();
  const { data: orgQuestions } = useQuery({
    ...questionsWithOptionsQuery(),
    enabled: open,
  });

  const [idMapFile, setIdMapFile] = useState<File | null>(null);
  const [surveyFile, setSurveyFile] = useState<File | null>(null);
  const [idMap, setIdMap] = useState<VanIdMapParse | null>(null);
  const [survey, setSurvey] = useState<VanSurveyParse | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [choices, setChoices] = useState<Record<string, QuestionChoice>>({});
  const [stats, setStats] = useState<VanImportStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [autoMatched, setAutoMatched] = useState(false);

  const selectableQuestions = useMemo(
    () => (orgQuestions ?? []).filter((q) => !q.archived),
    [orgQuestions],
  );

  // Apply external-id / name auto-match once org questions are available after survey load.
  useEffect(() => {
    if (!survey?.ok || autoMatched || selectableQuestions.length === 0) return;
    setChoices(defaultChoicesFor(survey, selectableQuestions));
    setAutoMatched(true);
  }, [survey, selectableQuestions, autoMatched]);

  const claimedQuestionIds = useMemo(() => {
    const ids = new Set<string>();
    for (const choice of Object.values(choices)) {
      if (choice?.kind === "match") ids.add(choice.questionId);
    }
    return ids;
  }, [choices]);

  const mappings = useMemo(() => {
    if (!survey) return [];
    const out: { questionVanId: string; questionId: string | null }[] = [];
    for (const q of survey.questions) {
      const choice = choices[q.questionVanId];
      if (!choice || choice.kind === "skip") continue;
      out.push({
        questionVanId: q.questionVanId,
        questionId: choice.kind === "match" ? choice.questionId : null,
      });
    }
    return out;
  }, [survey, choices]);

  const loadIdMap = async (file: File | null) => {
    setIdMapFile(file);
    setIdMap(null);
    setStats(null);
    setError(null);
    setParseError(null);
    if (!file) return;
    try {
      const parsed = parseVanIdMapBytes(await file.arrayBuffer());
      setIdMap(parsed);
      if (!parsed.ok) {
        setParseError(`ID map missing required column(s): ${parsed.missingColumns.join(", ")}.`);
      }
    } catch (e) {
      setParseError(e instanceof Error ? e.message : "Could not read ID map.");
    }
  };

  const loadSurvey = async (file: File | null) => {
    setSurveyFile(file);
    setSurvey(null);
    setChoices({});
    setAutoMatched(false);
    setStats(null);
    setError(null);
    setParseError(null);
    if (!file) return;
    try {
      const parsed = parseVanSurveyExportBytes(await file.arrayBuffer());
      setSurvey(parsed);
      if (!parsed.ok) {
        setParseError(
          `Survey export missing required column(s): ${parsed.missingColumns.join(", ")}.`,
        );
        return;
      }
      setChoices(defaultChoicesFor(parsed, selectableQuestions));
      setAutoMatched(selectableQuestions.length > 0);
    } catch (e) {
      setParseError(e instanceof Error ? e.message : "Could not read survey export.");
    }
  };

  const canSubmit =
    idMapFile != null &&
    surveyFile != null &&
    idMap?.ok === true &&
    survey?.ok === true &&
    mappings.length > 0;

  const submit = useMutation({
    mutationFn: async () => {
      if (!idMapFile || !surveyFile || !canSubmit) return null;
      const body = new FormData();
      body.set("idMap", idMapFile);
      body.set("survey", surveyFile);
      body.set("mappings", JSON.stringify(mappings));
      const res = await fetch(`/api/web/${orgSlug}/van-import`, {
        method: "POST",
        body,
      });
      if (!res.ok) throw new Error(await res.text());
      return (await res.json()) as VanImportStats;
    },
    onSuccess: (res) => {
      if (res) {
        setStats(res);
        void queryClient.invalidateQueries({ queryKey: ["questions"] });
      }
    },
    onError: (e) => setError(e.message),
  });

  const reset = () => {
    setIdMapFile(null);
    setSurveyFile(null);
    setIdMap(null);
    setSurvey(null);
    setChoices({});
    setAutoMatched(false);
    setParseError(null);
    setStats(null);
    setError(null);
  };

  const pending = submit.isPending;

  const choiceLabel = (choice: QuestionChoice | undefined): string => {
    if (!choice || choice.kind === "skip") return "Skip";
    if (choice.kind === "create") return "Create new";
    return selectableQuestions.find((q) => q.questionId === choice.questionId)?.name ?? "Match…";
  };

  const optionCoverage = (vanQuestionId: string, choice: QuestionChoice | undefined) => {
    if (!survey || !choice || choice.kind !== "match") return null;
    const preview = survey.questions.find((q) => q.questionVanId === vanQuestionId);
    const existing = selectableQuestions.find((q) => q.questionId === choice.questionId);
    if (!preview || !existing) return null;
    const texts = new Set(
      existing.options.filter((o) => !o.archived).map((o) => o.text.trim().toLowerCase()),
    );
    const missing = preview.responses.filter((r) => !texts.has(r.text.trim().toLowerCase()));
    return { missing, total: preview.responses.length };
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (pending && !next) return;
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-w-xl">
        <DialogTitle>Import VAN responses</DialogTitle>
        {stats ? null : (
          <DialogDescription>
            Upload a VAN ID map and survey-results export. Match each survey question to an existing
            question, or create a new one. Options match by text; missing options are added.
            Contacts use DateCanvassed.
          </DialogDescription>
        )}

        {stats ? (
          <div className="flex flex-col gap-4">
            <Callout tone="success">
              Imported <span className="font-medium">{stats.peopleWritten.toLocaleString()}</span>{" "}
              people ({stats.responsesInserted.toLocaleString()} new responses
              {stats.responsesDeduped > 0
                ? `, ${stats.responsesDeduped.toLocaleString()} already imported`
                : ""}
              ).
              {stats.questionsMatched > 0
                ? ` Matched ${stats.questionsMatched} existing questions.`
                : null}
              {stats.questionsCreated > 0 ? ` Created ${stats.questionsCreated} questions.` : null}
              {stats.optionsCreated > 0 ? ` Added ${stats.optionsCreated} options.` : null}
              {stats.peopleSkippedUnmatched > 0 ? (
                <>
                  {" "}
                  Skipped{" "}
                  <span className="font-medium">
                    {stats.peopleSkippedUnmatched.toLocaleString()}
                  </span>{" "}
                  StateFileIDs not in the active dataset.
                </>
              ) : null}
              {stats.peopleSkippedUnmapped > 0 ? (
                <>
                  {" "}
                  Skipped{" "}
                  <span className="font-medium">
                    {stats.peopleSkippedUnmapped.toLocaleString()}
                  </span>{" "}
                  VANIDs missing from the ID map.
                </>
              ) : null}
            </Callout>
            {stats.sampleUnmatchedExternalIds.length > 0 ? (
              <p className="text-xs text-muted-foreground">
                Unmatched StateFileID sample: {stats.sampleUnmatchedExternalIds.join(", ")}
              </p>
            ) : null}
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => reset()}>
                Import another
              </Button>
              <DialogClose render={<Button />}>Done</DialogClose>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium">ID map</label>
              <Input
                type="file"
                accept=".xls,.txt,.tsv,.csv,text/plain"
                disabled={pending}
                onChange={(e) => void loadIdMap(e.target.files?.[0] ?? null)}
              />
              {idMapFile && idMap?.ok ? (
                <span className="text-xs text-muted-foreground">
                  {idMapFile.name} · {idMap.rowCount.toLocaleString()} VANID ↔ StateFileID pairs
                </span>
              ) : idMapFile ? (
                <span className="text-xs text-muted-foreground">{idMapFile.name}</span>
              ) : null}
            </div>

            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium">Survey results</label>
              <Input
                type="file"
                accept=".xls,.txt,.tsv,.csv,text/plain"
                disabled={pending}
                onChange={(e) => void loadSurvey(e.target.files?.[0] ?? null)}
              />
              {surveyFile && survey?.ok ? (
                <span className="text-xs text-muted-foreground">
                  {surveyFile.name} · {survey.rowCount.toLocaleString()} answers ·{" "}
                  {survey.questions.length} questions
                </span>
              ) : surveyFile ? (
                <span className="text-xs text-muted-foreground">{surveyFile.name}</span>
              ) : null}
            </div>

            {parseError ? <DialogError error={parseError} /> : null}

            {survey?.ok ? (
              <div className="flex max-h-80 flex-col gap-1 overflow-y-auto">
                <div className="flex items-center justify-between">
                  <div className="text-sm font-medium">Question matching</div>
                  <div className="flex gap-2">
                    <Button
                      variant="ghost"
                      size="xs"
                      disabled={pending}
                      onClick={() => {
                        setChoices(defaultChoicesFor(survey, selectableQuestions));
                        setAutoMatched(true);
                      }}
                    >
                      Auto-match
                    </Button>
                    <Button
                      variant="ghost"
                      size="xs"
                      disabled={pending}
                      onClick={() => {
                        const next: Record<string, QuestionChoice> = {};
                        for (const q of survey.questions) {
                          next[q.questionVanId] = { kind: "create" };
                        }
                        setChoices(next);
                      }}
                    >
                      Create all
                    </Button>
                    <Button
                      variant="ghost"
                      size="xs"
                      disabled={pending}
                      onClick={() => {
                        const next: Record<string, QuestionChoice> = {};
                        for (const q of survey.questions) {
                          next[q.questionVanId] = { kind: "skip" };
                        }
                        setChoices(next);
                      }}
                    >
                      Skip all
                    </Button>
                  </div>
                </div>
                {survey.questions.map((q) => {
                  const choice = choices[q.questionVanId];
                  const coverage = optionCoverage(q.questionVanId, choice);
                  return (
                    <div
                      key={q.questionVanId}
                      className="flex flex-col gap-1 rounded-md border border-border px-2 py-1.5"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-medium">{q.name}</div>
                          <div className="text-xs text-muted-foreground">
                            VAN {q.questionVanId} · {q.answerCount.toLocaleString()} answers ·{" "}
                            {q.responses.length} options
                            {q.multiSelect ? " · multi" : ""}
                          </div>
                        </div>
                        <DropdownMenu>
                          <DropdownMenuTrigger
                            render={<Button variant="outline" size="sm" disabled={pending} />}
                          >
                            {choiceLabel(choice)}
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="max-h-64 overflow-y-auto">
                            <DropdownMenuItem
                              onClick={() =>
                                setChoices((c) => ({
                                  ...c,
                                  [q.questionVanId]: { kind: "skip" },
                                }))
                              }
                            >
                              Skip
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onClick={() =>
                                setChoices((c) => ({
                                  ...c,
                                  [q.questionVanId]: { kind: "create" },
                                }))
                              }
                            >
                              Create new
                            </DropdownMenuItem>
                            {selectableQuestions.length > 0 ? <DropdownMenuSeparator /> : null}
                            {selectableQuestions.map((oq) => {
                              const taken =
                                claimedQuestionIds.has(oq.questionId) &&
                                !(choice?.kind === "match" && choice.questionId === oq.questionId);
                              return (
                                <DropdownMenuItem
                                  key={oq.questionId}
                                  disabled={taken}
                                  onClick={() =>
                                    setChoices((c) => ({
                                      ...c,
                                      [q.questionVanId]: {
                                        kind: "match",
                                        questionId: oq.questionId,
                                      },
                                    }))
                                  }
                                >
                                  {oq.name}
                                  {vanExternalId(oq) === q.questionVanId ? " · linked" : ""}
                                </DropdownMenuItem>
                              );
                            })}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                      {coverage && coverage.missing.length > 0 ? (
                        <p className="text-xs text-muted-foreground">
                          Will add {coverage.missing.length} missing option
                          {coverage.missing.length === 1 ? "" : "s"}:{" "}
                          {coverage.missing
                            .slice(0, 4)
                            .map((m) => m.text)
                            .join(", ")}
                          {coverage.missing.length > 4 ? ` (+${coverage.missing.length - 4})` : ""}
                        </p>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            ) : null}

            {error ? <DialogError error={error} /> : null}

            <div className="flex justify-end gap-2">
              <DialogClose render={<Button variant="outline" type="button" disabled={pending} />}>
                Cancel
              </DialogClose>
              <Button disabled={!canSubmit || pending} onClick={() => submit.mutate()}>
                {pending ? "Importing…" : "Import"}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
