import { Icon } from "~/components/icon";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { Reorder, useDragControls } from "motion/react";
import { Fragment, useEffect, useRef, useState } from "react";
import { notify } from "~/lib/notify";
import { Badge } from "~/components/badge";
import { DialogError } from "~/components/callout";
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
import {
  type BadgeMeta,
  BlurSaveTextarea,
  QuestionTextEditor,
  RESPONSE_TYPE_META,
  ResponseOptionsEditor,
  type ResponseType,
  ResponseTypePicker,
} from "~/components/question-editor-parts";
import { scriptDetailQuery, scriptsListQuery } from "~/lib/queries/scripts";
import { useConfirmHotkey } from "~/lib/use-confirm-hotkey";
import {
  seedQuestionDetail,
  questionDetailQuery,
  questionsListQuery,
} from "~/lib/queries/questions";
import { GRAY } from "~/lib/palette";
import { useRememberSelection } from "~/lib/last-selected";
import { cn } from "~/lib/utils";
import { client } from "~/rpc/client";

type ScriptStepRow = {
  scriptStepId: string;
  order: number;
  stepType: string;
  questionId: string | null;
  text: string | null;
  showIfOptionId: string | null;
};

export const Route = createFileRoute("/$orgSlug/scripts/$scriptId")({
  loader: async ({ context: { queryClient }, params: { orgSlug, scriptId }, preload }) => {
    const scripts = await queryClient.fetchQuery(scriptsListQuery());
    const exists = scripts.some((s) => s.scriptId === scriptId);
    if (!exists) {
      // Redirect only on real navigations — a redirect thrown during a
      // hover preload gets committed and auto-navigates.
      if (preload) return;
      throw redirect({ to: "/$orgSlug/scripts", params: { orgSlug } });
    }
    const detail = await queryClient.fetchQuery(scriptDetailQuery(scriptId));
    // Prefetch each question step's detail (text + options) so step rows
    // render synchronously without a flash. Also seed the org-wide list
    // so the "Add question" dropdown is hot.
    await Promise.all([
      queryClient.prefetchQuery(questionsListQuery()),
      ...(detail?.steps ?? [])
        .filter((s) => s.stepType === "question" && s.questionId)
        .map((s) => queryClient.prefetchQuery(questionDetailQuery(s.questionId!))),
    ]);
  },
  component: ScriptEditor,
});

function ScriptEditor() {
  const queryClient = useQueryClient();
  const { orgSlug, scriptId } = Route.useParams();
  // The scripts index redirects back here next visit.
  useRememberSelection(orgSlug, "scripts", scriptId);
  const { data: script } = useQuery(scriptDetailQuery(scriptId));

  const steps: ScriptStepRow[] = script?.steps ?? [];
  const [draft, setDraft] = useState<ScriptStepRow[] | null>(null);
  const displaySteps = draft ?? steps;

  // Step bodies and the preview render from per-question detail queries; on
  // slow fetches a partial column (condition annotations without content)
  // would render and then grow, yanking restored scroll around. Gate the
  // first render until every detail is cached — a one-shot latch, so a step
  // added later (detail still prefetching) falls back to its own inline
  // placeholder instead of blanking the editor.
  const detailQueries = useQueries({
    queries: steps.filter((s) => s.questionId).map((s) => questionDetailQuery(s.questionId!)),
  });
  // `!!script` guards the vacuous case: before the script loads, steps is []
  // and every() over zero queries is true — the latch must not engage then.
  const detailsReady = !!script && detailQueries.every((d) => d.data !== undefined);
  const readyOnceRef = useRef(false);
  if (detailsReady) readyOnceRef.current = true;

  const setSteps = (updater: (prev: ScriptStepRow[]) => ScriptStepRow[]) => {
    const key = ["script", scriptId];
    const prev = queryClient.getQueryData<{ steps: ScriptStepRow[] } & object>(key);
    if (!prev) return null;
    queryClient.setQueryData(key, { ...prev, steps: updater(prev.steps) });
    return prev;
  };

  const addText = useMutation({
    mutationFn: () => client.scripts.addStep({ scriptId, stepType: "text", text: "" }),
    onSuccess: (row) => {
      setSteps((s) => [...s, row]);
    },
    onError: (e) => {
      console.error("scripts.addStep failed", e);
      notify.error(e.message);
    },
  });

  const { data: questions = [] } = useQuery(questionsListQuery());
  // A script can't repeat the same question — the canvasser response model
  // keys per questionId, so two occurrences would share answers.
  const usedQuestionIds = new Set(steps.filter((s) => s.questionId).map((s) => s.questionId!));
  const availableQuestions = questions.filter((q) => !usedQuestionIds.has(q.questionId));

  const addExistingQuestion = useMutation({
    mutationFn: (questionId: string) =>
      client.scripts.addStep({ scriptId, stepType: "question", questionId }),
    onMutate: (questionId) => {
      // Warm the detail cache in parallel so the new step row renders
      // without a "Loading…" flash.
      void queryClient.prefetchQuery(questionDetailQuery(questionId));
    },
    onSuccess: (row) => {
      setSteps((s) => [...s, row]);
      // usedCount on the questions list reflects script_step references.
      void queryClient.invalidateQueries({ queryKey: ["questions"] });
    },
    onError: (e) => {
      console.error("scripts.addStep failed", e);
      notify.error(e.message);
    },
  });

  const [newQuestionDialogOpen, setNewQuestionDialogOpen] = useState(false);

  const createAndAddQuestion = useMutation({
    mutationFn: async (input: { name: string; responseType: ResponseType }) => {
      const question = await client.questions.create(input);
      const step = await client.scripts.addStep({
        scriptId,
        stepType: "question",
        questionId: question.questionId,
      });
      return { question, step };
    },
    onSuccess: ({ question, step }) => {
      seedQuestionDetail(queryClient, question);
      setSteps((s) => [...s, step]);
      void queryClient.invalidateQueries({ queryKey: ["questions"] });
      setNewQuestionDialogOpen(false);
    },
    onError: (e) => {
      console.error("create question + addStep failed", e);
      notify.error(e.message);
    },
  });

  // Step removal is gated: blocked while another step's visibility depends on
  // the step's question, confirmed when the script is live in published turfs,
  // immediate otherwise. Snapshot state is split from `open` so the dialog
  // keeps its body during the close animation.
  const [stepRemoveGate, setStepRemoveGate] = useState<StepRemoveGate>({ kind: "blocked" });
  const [stepRemoveOpen, setStepRemoveOpen] = useState(false);

  // Computed from the live step list + cached question options so it tracks
  // condition edits instantly; the server guard backstops a cold detail cache.
  const stepGatesOthers = (step: ScriptStepRow): boolean => {
    if (!step.questionId) return false;
    const detail = queryClient.getQueryData<{ options: { responseOptionId: string }[] }>([
      "question",
      step.questionId,
    ]);
    if (!detail) return false;
    const optionIds = new Set(detail.options.map((o) => o.responseOptionId));
    return displaySteps.some(
      (s) =>
        s.scriptStepId !== step.scriptStepId &&
        s.showIfOptionId !== null &&
        optionIds.has(s.showIfOptionId),
    );
  };

  const handleRemoveStep = async (step: ScriptStepRow) => {
    // The dependency check is local (live step list + cached options), so the
    // blocked case never waits on the network.
    if (stepGatesOthers(step)) {
      setStepRemoveGate({ kind: "blocked" });
      setStepRemoveOpen(true);
      return;
    }
    let liveTurfCount: number;
    try {
      const res = await queryClient.fetchQuery({
        queryKey: ["script-live-turfs", scriptId],
        queryFn: () => client.scripts.countLiveTurfs({ scriptId }),
        staleTime: 0,
      });
      liveTurfCount = res.count;
    } catch (e) {
      notify.error(e instanceof Error ? e.message : String(e));
      return;
    }
    if (liveTurfCount > 0) {
      setStepRemoveGate({
        kind: "confirm",
        scriptStepId: step.scriptStepId,
        stepType: step.stepType,
        turfCount: liveTurfCount,
      });
      setStepRemoveOpen(true);
    } else {
      removeStep.mutate(step.scriptStepId);
    }
  };

  const removeStep = useMutation({
    mutationFn: (scriptStepId: string) => client.scripts.removeStep({ scriptId, scriptStepId }),
    onMutate: (scriptStepId) => {
      const prev = setSteps((s) => s.filter((x) => x.scriptStepId !== scriptStepId));
      return { prev };
    },
    onError: (e, _id, ctx) => {
      console.error("scripts.removeStep failed", e);
      notify.error(e.message);
      if (ctx?.prev) queryClient.setQueryData(["script", scriptId], ctx.prev);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["questions"] });
      void queryClient.invalidateQueries({ queryKey: ["script", scriptId] });
    },
  });

  const reorderSteps = useMutation({
    mutationFn: (ids: string[]) => client.scripts.reorderSteps({ scriptId, scriptStepIds: ids }),
    onMutate: (ids) => {
      const prev = setSteps((s) => {
        const byId = new Map(s.map((step) => [step.scriptStepId, step]));
        return ids.map((id, i) => {
          const step = byId.get(id);
          return step ? { ...step, order: i } : step!;
        });
      });
      return { prev };
    },
    onError: (e, _ids, ctx) => {
      console.error("scripts.reorderSteps failed", e);
      notify.error(e.message);
      if (ctx?.prev) queryClient.setQueryData(["script", scriptId], ctx.prev);
    },
    onSuccess: () => {
      // The server clears conditions the new order made forward-pointing.
      void queryClient.invalidateQueries({ queryKey: ["script", scriptId] });
    },
  });

  const setCondition = useMutation({
    mutationFn: (input: { scriptStepId: string; showIfOptionId: string | null }) =>
      client.scripts.setStepCondition({ scriptId, ...input }),
    onMutate: (input) => {
      const prev = setSteps((s) =>
        s.map((x) =>
          x.scriptStepId === input.scriptStepId
            ? { ...x, showIfOptionId: input.showIfOptionId }
            : x,
        ),
      );
      return { prev };
    },
    onError: (e, _input, ctx) => {
      console.error("scripts.setStepCondition failed", e);
      notify.error(e.message);
      if (ctx?.prev) queryClient.setQueryData(["script", scriptId], ctx.prev);
    },
  });

  const updateText = useMutation({
    mutationFn: (input: { scriptStepId: string; text: string }) =>
      client.scripts.updateTextStep({ scriptId, ...input }),
    onMutate: (input) => {
      const prev = setSteps((s) =>
        s.map((x) => (x.scriptStepId === input.scriptStepId ? { ...x, text: input.text } : x)),
      );
      return { prev };
    },
    onError: (e, _input, ctx) => {
      console.error("scripts.updateTextStep failed", e);
      notify.error(e.message);
      if (ctx?.prev) queryClient.setQueryData(["script", scriptId], ctx.prev);
    },
  });

  const handleDragEnd = () => {
    if (!draft) return;
    const newOrder = draft.map((s) => s.scriptStepId);
    const previousOrder = steps.map((s) => s.scriptStepId);
    const changed = newOrder.some((id, i) => id !== previousOrder[i]);
    if (changed) reorderSteps.mutate(newOrder);
    setDraft(null);
  };

  const stepsContainerRef = useRef<HTMLDivElement>(null);
  // Track per-script so tabbing between scripts doesn't read "count grew."
  const prevStepsRef = useRef<{ scriptId: string; length: number } | null>(null);
  useEffect(() => {
    // While the script itself is loading, steps going 0→N is data arrival,
    // not a user add — don't record a baseline or scroll.
    if (!script) return;
    const prev = prevStepsRef.current;
    if (
      prev &&
      prev.scriptId === scriptId &&
      steps.length > prev.length &&
      stepsContainerRef.current
    ) {
      stepsContainerRef.current.scrollTo({
        top: stepsContainerRef.current.scrollHeight,
        behavior: "smooth",
      });
    }
    prevStepsRef.current = { scriptId, length: steps.length };
  }, [script, scriptId, steps.length]);

  if (!script || !readyOnceRef.current) return null;

  return (
    <>
      <div className="flex h-full gap-4">
        <div
          ref={stepsContainerRef}
          className="flex w-[32rem] shrink-0 flex-col gap-3 overflow-y-auto"
        >
          <div
            className={cn(
              "sticky top-0 z-10 bg-background flex gap-2",
              "before:content-[''] before:absolute before:inset-x-0 before:-top-2 before:h-2 before:bg-background before:-z-10",
              "after:content-[''] after:absolute after:inset-x-0 after:top-full after:h-2 after:bg-background after:-z-10",
            )}
          >
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="outline"
                    className="flex-1 justify-start"
                    loading={addExistingQuestion.isPending || createAndAddQuestion.isPending}
                  />
                }
              >
                <Icon name="plus" />
                Add question
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                {availableQuestions.map((q) => (
                  <DropdownMenuItem
                    key={q.questionId}
                    onClick={() => addExistingQuestion.mutate(q.questionId)}
                  >
                    <span className="truncate">{q.name}</span>
                  </DropdownMenuItem>
                ))}
                {availableQuestions.length > 0 ? <DropdownMenuSeparator /> : null}
                <DropdownMenuItem onClick={() => setNewQuestionDialogOpen(true)}>
                  <Icon name="plus" />
                  <span>New question</span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <Button
              variant="outline"
              className="flex-1 justify-start"
              onClick={() => addText.mutate()}
              loading={addText.isPending}
            >
              <Icon name="plus" />
              Add text
            </Button>
          </div>
          {displaySteps.length === 0 ? null : (
            <Reorder.Group
              axis="y"
              values={displaySteps}
              onReorder={setDraft}
              as="div"
              className="flex flex-col gap-3"
            >
              {displaySteps.map((step, idx) => (
                <ReorderStepRow
                  key={step.scriptStepId}
                  number={idx + 1}
                  step={step}
                  earlierSteps={displaySteps.slice(0, idx)}
                  onRemove={() => handleRemoveStep(step)}
                  onChangeText={(text) =>
                    updateText.mutate({ scriptStepId: step.scriptStepId, text })
                  }
                  onSetCondition={(showIfOptionId) =>
                    setCondition.mutate({ scriptStepId: step.scriptStepId, showIfOptionId })
                  }
                  onDragEnd={handleDragEnd}
                />
              ))}
            </Reorder.Group>
          )}
        </div>
        <ScriptPreview name={script.name} steps={displaySteps} />
      </div>

      <NewQuestionDialog
        open={newQuestionDialogOpen}
        onOpenChange={setNewQuestionDialogOpen}
        pending={createAndAddQuestion.isPending}
        error={createAndAddQuestion.error?.message ?? null}
        onSubmit={(name, responseType) => createAndAddQuestion.mutate({ name, responseType })}
      />
      <RemoveStepDialog
        open={stepRemoveOpen}
        onOpenChange={setStepRemoveOpen}
        gate={stepRemoveGate}
        onConfirm={() => {
          if (stepRemoveGate.kind === "confirm") removeStep.mutate(stepRemoveGate.scriptStepId);
          setStepRemoveOpen(false);
        }}
      />
    </>
  );
}

type StepRemoveGate =
  | { kind: "blocked" }
  | { kind: "confirm"; scriptStepId: string; stepType: string; turfCount: number };

function RemoveStepDialog({
  open,
  onOpenChange,
  gate,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  gate: StepRemoveGate;
  onConfirm: () => void;
}) {
  useConfirmHotkey({ open: open && gate.kind === "confirm", disabled: false, onConfirm });
  const isQuestion = gate.kind === "confirm" && gate.stepType === "question";
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        {gate.kind === "blocked" ? (
          <>
            <DialogTitle>Can't remove question</DialogTitle>
            <DialogDescription>
              Another script step depends on one of this question's options being selected. Remove
              that condition from the script first.
            </DialogDescription>
            <div className="mt-2 flex justify-end">
              <DialogClose render={<Button variant="outline" />}>Close</DialogClose>
            </div>
          </>
        ) : (
          <>
            <DialogTitle>Confirm remove?</DialogTitle>
            <DialogDescription>
              This script is used in{" "}
              <span className="font-bold text-foreground">{gate.turfCount}</span> published turf
              {gate.turfCount === 1 ? "" : "s"}. Removing this {isQuestion ? "question" : "text"}{" "}
              will hide it for canvassers
              {isQuestion ? ", but existing responses will be preserved" : ""}.
            </DialogDescription>
            <div className="mt-2 flex justify-end gap-2">
              <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
              <Button variant="destructive" onClick={onConfirm}>
                Remove {isQuestion ? "question" : "text"}
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function ReorderStepRow({
  onDragEnd,
  ...props
}: {
  number: number;
  step: ScriptStepRow;
  earlierSteps: ScriptStepRow[];
  onRemove: () => void;
  onChangeText: (text: string) => void;
  onSetCondition: (showIfOptionId: string | null) => void;
  onDragEnd?: () => void;
}) {
  const controls = useDragControls();
  return (
    <Reorder.Item
      value={props.step}
      dragListener={false}
      dragControls={controls}
      as="div"
      onDragEnd={onDragEnd}
      transition={{ layout: { type: "tween", duration: 0.15, ease: "easeOut" } }}
      dragTransition={{ bounceStiffness: 10000, bounceDamping: 500, power: 0 }}
    >
      <StepRow {...props} dragControls={controls} />
    </Reorder.Item>
  );
}

function StepRow({
  number,
  step,
  earlierSteps,
  onRemove,
  onChangeText,
  onSetCondition,
  dragControls,
}: {
  number: number;
  step: ScriptStepRow;
  earlierSteps: ScriptStepRow[];
  onRemove: () => void;
  onChangeText: (text: string) => void;
  onSetCondition: (showIfOptionId: string | null) => void;
  dragControls?: ReturnType<typeof useDragControls>;
}) {
  return (
    <div className="rounded-md border border-border bg-card p-3">
      {step.stepType === "question" && step.questionId ? (
        <QuestionStepBody
          number={number}
          questionId={step.questionId}
          onRemove={onRemove}
          dragControls={dragControls}
        />
      ) : (
        <TextStepBody
          number={number}
          text={step.text ?? ""}
          onChangeText={onChangeText}
          onRemove={onRemove}
          dragControls={dragControls}
        />
      )}
      <StepConditionRow step={step} earlierSteps={earlierSteps} onSet={onSetCondition} />
    </div>
  );
}

// Visibility-condition control at the foot of a step card: "Show only if" an
// earlier single-select step's option is chosen. Hidden entirely when there's
// no condition set and nothing earlier to condition on.
function StepConditionRow({
  step,
  earlierSteps,
  onSet,
}: {
  step: ScriptStepRow;
  earlierSteps: ScriptStepRow[];
  onSet: (showIfOptionId: string | null) => void;
}) {
  const candidateIds = earlierSteps
    .filter((s) => s.stepType === "question" && s.questionId)
    .map((s) => s.questionId!);
  // Details are loader-prefetched, so these are cache hits.
  const details = useQueries({ queries: candidateIds.map((id) => questionDetailQuery(id)) });
  const candidates = details
    .map((d) => d.data)
    .filter(
      (q): q is NonNullable<typeof q> =>
        q != null && q.responseType === "single_select" && q.options.length > 0,
    );

  let current: { question: string; option: string } | null = null;
  if (step.showIfOptionId != null) {
    for (const q of candidates) {
      const opt = q.options.find((o) => o.responseOptionId === step.showIfOptionId);
      if (opt) {
        current = { question: q.name, option: opt.text };
        break;
      }
    }
  }

  if (step.showIfOptionId == null && candidates.length === 0) return null;

  return (
    <div className="mt-3">
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="outline"
              size="sm"
              className={cn(step.showIfOptionId == null && "text-muted-foreground")}
            />
          }
        >
          <Icon name="corner-down-right" />
          {step.showIfOptionId == null
            ? "Show only if…"
            : current
              ? `Show only if ${current.question}: ${current.option}`
              : "Show only if: (unavailable option)"}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          {step.showIfOptionId != null ? (
            <>
              <DropdownMenuItem onClick={() => onSet(null)}>Always show</DropdownMenuItem>
              <DropdownMenuSeparator />
            </>
          ) : null}
          {candidates.map((q) => (
            <Fragment key={q.questionId}>
              <div className="px-2 pt-1.5 pb-0.5 text-sm text-muted-foreground">{q.name}</div>
              {q.options.map((o) => (
                <DropdownMenuItem
                  key={o.responseOptionId}
                  onClick={() => onSet(o.responseOptionId)}
                >
                  <span className="truncate">{o.text || "Empty option"}</span>
                  {o.responseOptionId === step.showIfOptionId ? (
                    <Icon name="check" className="ml-auto size-4 shrink-0" />
                  ) : null}
                </DropdownMenuItem>
              ))}
            </Fragment>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function GripHandle({ dragControls }: { dragControls?: ReturnType<typeof useDragControls> }) {
  return (
    <button
      type="button"
      className="cursor-grab touch-none text-muted-foreground/40 hover:text-muted-foreground shrink-0"
      onPointerDown={(e) => dragControls?.start(e)}
      aria-label="Drag to reorder"
    >
      <Icon name="grip-vertical" className="size-3.5" />
    </button>
  );
}

const TEXT_STEP_BADGE: BadgeMeta = { label: "Text", color: GRAY };

function KindBadge({ meta }: { meta: BadgeMeta }) {
  return <Badge color={meta.color}>{meta.label}</Badge>;
}

function RemoveButton({ onRemove }: { onRemove: () => void }) {
  return (
    <Button
      variant="outline"
      size="icon-xs"
      onClick={onRemove}
      onMouseDown={(e) => e.preventDefault()}
      aria-label="Remove step"
    >
      <Icon name="x" className="size-4" />
    </Button>
  );
}

function TextStepBody({
  number,
  text,
  onChangeText,
  onRemove,
  dragControls,
}: {
  number: number;
  text: string;
  onChangeText: (text: string) => void;
  onRemove: () => void;
  dragControls?: ReturnType<typeof useDragControls>;
}) {
  return (
    <>
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <GripHandle dragControls={dragControls} />
          <span className="text-sm text-muted-foreground pr-0.5 tabular-nums">{number}</span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <KindBadge meta={TEXT_STEP_BADGE} />
          <RemoveButton onRemove={onRemove} />
        </div>
      </div>
      <BlurSaveTextarea
        value={text}
        onCommit={onChangeText}
        placeholder="Script text..."
        rows={2}
      />
    </>
  );
}

function QuestionStepBody({
  number,
  questionId,
  onRemove,
  dragControls,
}: {
  number: number;
  questionId: string;
  onRemove: () => void;
  dragControls?: ReturnType<typeof useDragControls>;
}) {
  const queryClient = useQueryClient();
  const { data: question } = useQuery(questionDetailQuery(questionId));

  const renameQuestion = useMutation({
    mutationFn: (name: string) => client.questions.rename({ questionId, name }),
    onMutate: (name) => {
      const key = ["question", questionId];
      const prev = queryClient.getQueryData<typeof question>(key);
      queryClient.setQueryData<typeof question>(key, (old) => (old ? { ...old, name } : old));
      return { prev };
    },
    onError: (e, _name, ctx) => {
      console.error("questions.rename failed", e);
      notify.error(e.message);
      if (ctx?.prev) queryClient.setQueryData(["question", questionId], ctx.prev);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["questions"] });
    },
  });

  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState("");

  if (!question) {
    return (
      <div className="flex items-center gap-1.5">
        <GripHandle dragControls={dragControls} />
        <span className="text-sm text-muted-foreground tabular-nums">{number}</span>
        <span className="text-sm italic text-muted-foreground">Loading…</span>
      </div>
    );
  }

  // Clearing edit mode and the optimistic rename happen together in this one
  // component, so they re-render atomically.
  const commitName = () => {
    const next = nameDraft.trim();
    setEditingName(false);
    if (next && next !== question.name) renameQuestion.mutate(next);
  };

  return (
    <>
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5 flex-1">
          <GripHandle dragControls={dragControls} />
          <span className="text-sm text-muted-foreground pr-0.5 tabular-nums">{number}</span>
          {editingName ? (
            <Input
              autoFocus
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              onBlur={commitName}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
                else if (e.key === "Escape") setEditingName(false);
              }}
              // -my-1 lets the h-7 input render full-height while only
              // claiming the ~20px display-text height in layout, so editing
              // doesn't grow the row.
              className="-my-1 h-7 px-2 flex-1 min-w-0"
            />
          ) : (
            <span
              onDoubleClick={() => {
                setNameDraft(question.name);
                setEditingName(true);
              }}
              className="text-sm select-none cursor-text truncate flex-1 min-w-0"
              title="Double-click to rename"
            >
              {question.name}
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <KindBadge
            meta={
              RESPONSE_TYPE_META[question.responseType] ?? {
                label: question.responseType,
                color: GRAY,
              }
            }
          />
          <RemoveButton onRemove={onRemove} />
        </div>
      </div>
      <QuestionTextEditor questionId={questionId} />
      <div className={cn("mb-1", question.responseType === "open_ended" ? "mt-3" : "mt-4")}>
        <ResponseOptionsEditor questionId={questionId} />
      </div>
    </>
  );
}

// Reads from the same question cache the editor writes to, so edits flow live.
// Conditional steps are all shown (it's an editing aid, not a simulation),
// each annotated with its controlling option.
function ScriptPreview({ name, steps }: { name: string; steps: ScriptStepRow[] }) {
  const questionIds = steps.filter((s) => s.questionId).map((s) => s.questionId!);
  const details = useQueries({ queries: questionIds.map((id) => questionDetailQuery(id)) });
  const conditionByOption = new Map<string, string>();
  for (const d of details) {
    const q = d.data;
    if (!q) continue;
    for (const o of q.options) conditionByOption.set(o.responseOptionId, `${q.name}: ${o.text}`);
  }

  return (
    <div className="flex-1 min-w-0 flex flex-col rounded-md border border-border bg-card overflow-y-auto">
      <div className="px-4 py-4 flex flex-col gap-5">
        <div className="text-sm font-semibold">
          {name}
          <span className="text-muted-foreground ml-2">(Preview)</span>
        </div>
        {steps.map((step) => {
          const annotation =
            step.showIfOptionId != null ? (
              <p className="text-sm italic text-muted-foreground">
                Only if {conditionByOption.get(step.showIfOptionId) ?? "(unavailable option)"}
              </p>
            ) : null;
          if (step.stepType === "text") {
            return (
              <div key={step.scriptStepId} className="flex flex-col gap-1">
                {annotation}
                <p className="text-sm italic whitespace-pre-wrap">
                  {step.text?.trim() ? step.text : <span>Empty text</span>}
                </p>
              </div>
            );
          }
          if (step.questionId) {
            return (
              <div key={step.scriptStepId} className="flex flex-col gap-1">
                {annotation}
                <QuestionPreview questionId={step.questionId} />
              </div>
            );
          }
          return null;
        })}
      </div>
    </div>
  );
}

function QuestionPreview({ questionId }: { questionId: string }) {
  const { data } = useQuery(questionDetailQuery(questionId));
  if (!data) return null;
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm">
        {data.text?.trim() ? (
          data.text
        ) : (
          <span className="italic text-muted-foreground">Untitled question</span>
        )}
      </p>
      <div className="flex flex-col gap-1.5">
        {data.responseType === "open_ended" ? (
          // Input facsimile, same visual weight as the option rows.
          <div className="rounded-md border border-border bg-card px-3 py-1.5 text-sm">
            <span className="italic text-muted-foreground">
              Answers are typed in by the canvasser
            </span>
          </div>
        ) : (
          <>
            {data.options.map((opt) => (
              <div
                key={opt.responseOptionId}
                className="rounded-md border border-border bg-card px-3 py-1.5 text-sm"
              >
                {opt.text?.trim() ? (
                  opt.text
                ) : (
                  <span className="italic text-muted-foreground">Empty option</span>
                )}
              </div>
            ))}
            {data.options.length === 0 && (
              <p className="text-sm italic text-muted-foreground">No options</p>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function NewQuestionDialog({
  open,
  onOpenChange,
  pending,
  error,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pending: boolean;
  error: string | null;
  onSubmit: (name: string, responseType: ResponseType) => void;
}) {
  const [name, setName] = useState("");
  const [responseType, setResponseType] = useState<ResponseType>("single_select");
  useEffect(() => {
    if (open) {
      setName("");
      setResponseType("single_select");
    }
  }, [open]);
  const valid = name.trim().length > 0;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogTitle>Create new question</DialogTitle>
        <DialogDescription>
          Pick a short name for display and the type of question. You'll edit the full question text
          and responses next.
        </DialogDescription>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!valid || pending) return;
            onSubmit(name.trim(), responseType);
          }}
          className="flex flex-col gap-4"
        >
          <div className="flex flex-col gap-1.5">
            <label className="text-sm text-muted-foreground">Name</label>
            <Input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Candidate support"
              disabled={pending}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-sm text-muted-foreground">Type</label>
            <ResponseTypePicker
              value={responseType}
              onChange={setResponseType}
              disabled={pending}
            />
          </div>
          <DialogError error={error} />
          <div className="mt-2 flex justify-end gap-2">
            <DialogClose render={<Button variant="outline" type="button" />}>Cancel</DialogClose>
            <Button type="submit" disabled={!valid} loading={pending}>
              Create
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
