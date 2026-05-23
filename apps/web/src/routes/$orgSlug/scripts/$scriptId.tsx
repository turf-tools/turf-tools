import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { ChevronDown, GripVertical, Plus, X } from "lucide-react";
import { Reorder, useDragControls } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
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
} from "~/components/question-editor-parts";
import { scriptDetailQuery, scriptsListQuery } from "~/lib/queries/scripts";
import {
  seedQuestionDetail,
  surveyQuestionDetailQuery,
  surveyQuestionsListQuery,
} from "~/lib/queries/survey-questions";
import { cn } from "~/lib/utils";
import { client } from "~/rpc/client";

type ScriptStepRow = {
  scriptStepId: string;
  order: number;
  stepType: string;
  surveyQuestionId: string | null;
  text: string | null;
};

export const Route = createFileRoute("/$orgSlug/scripts/$scriptId")({
  loader: async ({ context: { queryClient }, params: { orgSlug, scriptId } }) => {
    const scripts = await queryClient.fetchQuery(scriptsListQuery());
    const exists = scripts.some((s) => s.scriptId === scriptId);
    if (!exists) {
      throw redirect({ to: "/$orgSlug/scripts", params: { orgSlug } });
    }
    const detail = await queryClient.fetchQuery(scriptDetailQuery(scriptId));
    // Prefetch each question step's detail (text + options) so step rows
    // render synchronously without a flash. Also seed the org-wide list
    // so the "Add question" dropdown is hot.
    await Promise.all([
      queryClient.prefetchQuery(surveyQuestionsListQuery()),
      ...(detail?.steps ?? [])
        .filter((s) => s.stepType === "question" && s.surveyQuestionId)
        .map((s) => queryClient.prefetchQuery(surveyQuestionDetailQuery(s.surveyQuestionId!))),
    ]);
  },
  component: ScriptEditor,
});

function ScriptEditor() {
  const queryClient = useQueryClient();
  const { scriptId } = Route.useParams();
  const { data: script } = useQuery(scriptDetailQuery(scriptId));

  const steps: ScriptStepRow[] = script?.steps ?? [];
  const [draft, setDraft] = useState<ScriptStepRow[] | null>(null);
  const displaySteps = draft ?? steps;

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
      toast.error(e.message);
    },
  });

  const { data: surveyQuestions = [] } = useQuery(surveyQuestionsListQuery());
  // A script can't repeat the same question — the canvasser response model
  // keys per surveyQuestionId, so two occurrences would share answers.
  const usedQuestionIds = new Set(
    steps.filter((s) => s.surveyQuestionId).map((s) => s.surveyQuestionId!),
  );
  const availableQuestions = surveyQuestions.filter(
    (q) => !usedQuestionIds.has(q.surveyQuestionId),
  );

  const addExistingQuestion = useMutation({
    mutationFn: (surveyQuestionId: string) =>
      client.scripts.addStep({ scriptId, stepType: "question", surveyQuestionId }),
    onMutate: (surveyQuestionId) => {
      // Warm the detail cache in parallel so the new step row renders
      // without a "Loading…" flash.
      void queryClient.prefetchQuery(surveyQuestionDetailQuery(surveyQuestionId));
    },
    onSuccess: (row) => {
      setSteps((s) => [...s, row]);
      // usedCount on the questions list reflects script_step references.
      void queryClient.invalidateQueries({ queryKey: ["survey-questions"] });
    },
    onError: (e) => {
      console.error("scripts.addStep failed", e);
      toast.error(e.message);
    },
  });

  const [newQuestionDialogOpen, setNewQuestionDialogOpen] = useState(false);

  const createAndAddQuestion = useMutation({
    mutationFn: async (input: { name: string; responseType: "single_select" }) => {
      const question = await client.surveyQuestions.create(input);
      const step = await client.scripts.addStep({
        scriptId,
        stepType: "question",
        surveyQuestionId: question.surveyQuestionId,
      });
      return { question, step };
    },
    onSuccess: ({ question, step }) => {
      seedQuestionDetail(queryClient, question);
      setSteps((s) => [...s, step]);
      void queryClient.invalidateQueries({ queryKey: ["survey-questions"] });
      setNewQuestionDialogOpen(false);
    },
    onError: (e) => {
      console.error("create question + addStep failed", e);
      toast.error(e.message);
    },
  });

  const removeStep = useMutation({
    mutationFn: (scriptStepId: string) => client.scripts.removeStep({ scriptId, scriptStepId }),
    onMutate: (scriptStepId) => {
      const prev = setSteps((s) => s.filter((x) => x.scriptStepId !== scriptStepId));
      return { prev };
    },
    onError: (e, _id, ctx) => {
      console.error("scripts.removeStep failed", e);
      toast.error(e.message);
      if (ctx?.prev) queryClient.setQueryData(["script", scriptId], ctx.prev);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["survey-questions"] });
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
      toast.error(e.message);
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
      toast.error(e.message);
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
  const prevStepsLengthRef = useRef(steps.length);
  useEffect(() => {
    if (steps.length > prevStepsLengthRef.current && stepsContainerRef.current) {
      stepsContainerRef.current.scrollTo({
        top: stepsContainerRef.current.scrollHeight,
        behavior: "smooth",
      });
    }
    prevStepsLengthRef.current = steps.length;
  }, [steps.length]);

  if (!script) return null;

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
                <Plus />
                Add question
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                {availableQuestions.map((q) => (
                  <DropdownMenuItem
                    key={q.surveyQuestionId}
                    onClick={() => addExistingQuestion.mutate(q.surveyQuestionId)}
                  >
                    <span className="truncate">{q.name}</span>
                  </DropdownMenuItem>
                ))}
                {availableQuestions.length > 0 ? <DropdownMenuSeparator /> : null}
                <DropdownMenuItem onClick={() => setNewQuestionDialogOpen(true)}>
                  <Plus />
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
              <Plus />
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
                  onRemove={() => removeStep.mutate(step.scriptStepId)}
                  onChangeText={(text) =>
                    updateText.mutate({ scriptStepId: step.scriptStepId, text })
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
    </>
  );
}

function ReorderStepRow({
  onDragEnd,
  ...props
}: {
  number: number;
  step: ScriptStepRow;
  onRemove: () => void;
  onChangeText: (text: string) => void;
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
      transition={{ layout: { type: "tween", duration: 0.2, ease: "easeOut" } }}
      dragTransition={{ bounceStiffness: 10000, bounceDamping: 500, power: 0 }}
    >
      <StepRow {...props} dragControls={controls} />
    </Reorder.Item>
  );
}

function StepRow({
  number,
  step,
  onRemove,
  onChangeText,
  dragControls,
}: {
  number: number;
  step: ScriptStepRow;
  onRemove: () => void;
  onChangeText: (text: string) => void;
  dragControls?: ReturnType<typeof useDragControls>;
}) {
  return (
    <div className="rounded-md border border-border bg-card p-3">
      {step.stepType === "question" && step.surveyQuestionId ? (
        <QuestionStepBody
          number={number}
          surveyQuestionId={step.surveyQuestionId}
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
      <GripVertical className="size-3.5" />
    </button>
  );
}

// Mid-gray for text-step badges. schemeObservable10's gray is too light against bg-card.
const TEXT_STEP_BADGE: BadgeMeta = { label: "Text", color: "#6b7280" };

function KindBadge({ meta }: { meta: BadgeMeta }) {
  return (
    <span
      className="rounded px-1.5 py-0.5 text-xs font-medium"
      style={{ backgroundColor: `${meta.color}22`, color: meta.color }}
    >
      {meta.label}
    </span>
  );
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
      <X className="size-4" />
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
      <div className="mb-3 flex h-7 items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <GripHandle dragControls={dragControls} />
          <span className="text-sm text-muted-foreground pr-1">{number}</span>
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
  surveyQuestionId,
  onRemove,
  dragControls,
}: {
  number: number;
  surveyQuestionId: string;
  onRemove: () => void;
  dragControls?: ReturnType<typeof useDragControls>;
}) {
  const queryClient = useQueryClient();
  const { data: question } = useQuery(surveyQuestionDetailQuery(surveyQuestionId));

  const renameQuestion = useMutation({
    mutationFn: (name: string) => client.surveyQuestions.rename({ surveyQuestionId, name }),
    onMutate: (name) => {
      const key = ["survey-question", surveyQuestionId];
      const prev = queryClient.getQueryData<typeof question>(key);
      queryClient.setQueryData<typeof question>(key, (old) => (old ? { ...old, name } : old));
      return { prev };
    },
    onError: (e, _name, ctx) => {
      console.error("surveyQuestions.rename failed", e);
      toast.error(e.message);
      if (ctx?.prev) queryClient.setQueryData(["survey-question", surveyQuestionId], ctx.prev);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["survey-questions"] });
    },
  });

  if (!question) {
    return (
      <div className="flex items-center gap-1.5">
        <GripHandle dragControls={dragControls} />
        <span className="text-sm text-muted-foreground">{number}</span>
        <span className="text-sm italic text-muted-foreground">Loading…</span>
      </div>
    );
  }

  return (
    <>
      <div className="mb-3 flex h-7 items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5 flex-1">
          <GripHandle dragControls={dragControls} />
          <span className="text-sm text-muted-foreground pr-1">{number}</span>
          <DoubleClickEditInput
            value={question.name}
            onCommit={(name) => renameQuestion.mutate(name)}
            className="flex-1 min-w-0"
          />
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <KindBadge
            meta={
              RESPONSE_TYPE_META[question.responseType] ?? {
                label: question.responseType,
                color: "#9ca3af",
              }
            }
          />
          <RemoveButton onRemove={onRemove} />
        </div>
      </div>
      <QuestionTextEditor surveyQuestionId={surveyQuestionId} />
      <div className="mt-4 mb-1">
        <ResponseOptionsEditor surveyQuestionId={surveyQuestionId} />
      </div>
    </>
  );
}

// Empty commits revert silently to preserve the non-null DB invariant on `name`.
function DoubleClickEditInput({
  value,
  onCommit,
  className,
}: {
  value: string;
  onCommit: (text: string) => void;
  className?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [local, setLocal] = useState(value);
  useEffect(() => {
    if (!editing) setLocal(value);
  }, [value, editing]);

  if (!editing) {
    return (
      <span
        onDoubleClick={() => setEditing(true)}
        className={cn("text-sm select-none cursor-text truncate", className)}
        title="Double-click to rename"
      >
        {value}
      </span>
    );
  }
  return (
    <Input
      autoFocus
      value={local}
      onChange={(e) => setLocal(e.target.value)}
      onBlur={() => {
        const trimmed = local.trim();
        if (trimmed && trimmed !== value) onCommit(trimmed);
        setEditing(false);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          const target = e.currentTarget as HTMLInputElement;
          target.blur();
          target.closest<HTMLElement>('[role="dialog"]')?.focus();
        } else if (e.key === "Escape") {
          setLocal(value);
          setEditing(false);
        }
      }}
      className={cn("h-7 px-2", className)}
    />
  );
}

// Reads from the same survey-question cache the editor writes to, so edits flow live.
function ScriptPreview({ name, steps }: { name: string; steps: ScriptStepRow[] }) {
  return (
    <div className="flex-1 min-w-0 flex flex-col rounded-md border border-border bg-card overflow-y-auto">
      <div className="px-4 py-4 flex flex-col gap-5">
        <div className="text-sm font-semibold">
          {name}
          <span className="text-muted-foreground ml-2">(Preview)</span>
        </div>
        {steps.map((step) => {
          if (step.stepType === "text") {
            return (
              <p key={step.scriptStepId} className="text-sm italic whitespace-pre-wrap">
                {step.text?.trim() ? step.text : <span>Empty text</span>}
              </p>
            );
          }
          if (step.surveyQuestionId) {
            return (
              <QuestionPreview key={step.scriptStepId} surveyQuestionId={step.surveyQuestionId} />
            );
          }
          return null;
        })}
      </div>
    </div>
  );
}

function QuestionPreview({ surveyQuestionId }: { surveyQuestionId: string }) {
  const { data } = useQuery(surveyQuestionDetailQuery(surveyQuestionId));
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
        {data.options.map((opt) => (
          <div
            key={opt.surveyResponseOptionId}
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
  onSubmit: (name: string, responseType: "single_select") => void;
}) {
  const [name, setName] = useState("");
  const [responseType, setResponseType] = useState<"single_select">("single_select");
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
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    type="button"
                    variant="outline"
                    className="w-full justify-between font-normal"
                    disabled={pending}
                  />
                }
              >
                <span>{RESPONSE_TYPE_META[responseType]!.label}</span>
                <ChevronDown className="size-4 text-muted-foreground" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                <DropdownMenuItem onClick={() => setResponseType("single_select")}>
                  Single Select
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          {error ? (
            <div
              className={cn(
                "rounded-md border border-destructive/40 bg-destructive/10",
                "px-3 py-2 text-sm text-destructive",
              )}
            >
              {error}
            </div>
          ) : null}
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
