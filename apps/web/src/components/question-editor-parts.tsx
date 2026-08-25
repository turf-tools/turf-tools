import { Icon } from "~/components/icon";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BLUE, BROWN, PURPLE } from "~/lib/palette";
import { motion, Reorder, useDragControls } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { notify } from "~/lib/notify";
import { Button } from "~/components/button";
import { Input } from "~/components/input";
import { questionDetailQuery } from "~/lib/queries/questions";
import { cn } from "~/lib/utils";
import { client } from "~/rpc/client";

// Shared editors and metadata for questions. Components write
// optimistically against ["question", id], so any surface that
// renders them gets live-save with no coordination.

export type BadgeMeta = { label: string; color: string };

export type ResponseType = "single_select" | "multi_select" | "open_ended";

// Picker order.
export const RESPONSE_TYPES: ResponseType[] = ["single_select", "multi_select", "open_ended"];

// Keyed by questions.responseType.
export const RESPONSE_TYPE_META: Record<string, BadgeMeta> = {
  single_select: { label: "Single Select", color: BLUE },
  multi_select: { label: "Multi Select", color: PURPLE },
  open_ended: { label: "Open Ended", color: BROWN },
};

export function ResponseTypePicker({
  value,
  onChange,
  disabled,
}: {
  value: ResponseType;
  onChange: (value: ResponseType) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {RESPONSE_TYPES.map((t) => (
        <button
          type="button"
          key={t}
          onClick={() => onChange(t)}
          disabled={disabled}
          className={cn(
            "rounded-md border border-border px-2.5 py-1 text-sm disabled:cursor-not-allowed active:translate-y-px",
            value === t ? "bg-foreground/10" : "bg-background hover:bg-muted",
          )}
        >
          {RESPONSE_TYPE_META[t]!.label}
        </button>
      ))}
    </div>
  );
}

type ResponseOption = {
  responseOptionId: string;
  text: string;
  order: number;
};

type QuestionDetail = {
  questionId: string;
  name: string;
  responseType: string;
  text: string;
  createdAt: Date;
  archivedAt: Date | null;
  options: ResponseOption[];
};

export function QuestionTextEditor({ questionId }: { questionId: string }) {
  const queryClient = useQueryClient();
  const { data: question } = useQuery(questionDetailQuery(questionId));
  const questionKey = ["question", questionId];

  const updateText = useMutation({
    mutationFn: (text: string) => client.questions.updateText({ questionId, text }),
    onMutate: (text) => {
      const prev = queryClient.getQueryData<QuestionDetail>(questionKey);
      queryClient.setQueryData<QuestionDetail>(questionKey, (old) =>
        old ? { ...old, text } : old,
      );
      return { prev };
    },
    onSuccess: () => {
      // The questions list shows `text` per row.
      void queryClient.invalidateQueries({ queryKey: ["questions"] });
    },
    onError: (e, _text, ctx) => {
      console.error("questions.updateText failed", e);
      notify.error(e.message);
      if (ctx?.prev) queryClient.setQueryData(questionKey, ctx.prev);
    },
  });

  if (!question) return null;

  return (
    <BlurSaveTextarea
      value={question.text}
      onCommit={(text) => updateText.mutate(text)}
      placeholder="Full question text..."
      rows={2}
    />
  );
}

export function ResponseOptionsEditor({ questionId }: { questionId: string }) {
  const queryClient = useQueryClient();
  const { data: question } = useQuery(questionDetailQuery(questionId));

  const setDetail = (updater: (prev: QuestionDetail) => QuestionDetail) => {
    queryClient.setQueryData<QuestionDetail>(["question", questionId], (old) =>
      old ? updater(old) : old,
    );
  };

  // The option mutations below patch the ["question", id] detail cache directly;
  // options also feed the questions-with-options projection under the
  // ["questions"] prefix, so invalidate that on settle to keep them in sync.
  const refreshQuestionProjections = () =>
    void queryClient.invalidateQueries({ queryKey: ["questions"] });

  // Snapshot the option ids present at mount; anything not in the set
  // was added during the session, used to gate the X button's mount
  // fade-in. Bounded by mount-time count; doesn't grow with usage.
  const mountedIdsRef = useRef<Set<string> | null>(null);
  if (mountedIdsRef.current === null && question) {
    mountedIdsRef.current = new Set(question.options.map((o) => o.responseOptionId));
  }
  const isPreExisting = (id: string): boolean => mountedIdsRef.current?.has(id) ?? true;

  // Scroll a newly added option into view. `justAddedRef` is set on add and
  // consumed once the card's grow animation finishes (onLayoutAnimationComplete
  // on the button row below) — scrolling mid-animation lands short and clips
  // the card.
  const optionsEndRef = useRef<HTMLDivElement>(null);
  const justAddedRef = useRef(false);

  const addOption = useMutation({
    mutationFn: () => client.questions.addResponseOption({ questionId, text: "" }),
    onSettled: refreshQuestionProjections,
    onMutate: () => {
      justAddedRef.current = true;
      const tempId = `temp-${crypto.randomUUID()}`;
      setDetail((d) => ({
        ...d,
        options: [...d.options, { responseOptionId: tempId, text: "", order: d.options.length }],
      }));
      return { tempId };
    },
    onSuccess: (row, _vars, ctx) => {
      // Swap the temp row for the server-assigned one.
      setDetail((d) => ({
        ...d,
        options: d.options.map((o) => (o.responseOptionId === ctx.tempId ? row : o)),
      }));
    },
    onError: (e, _vars, ctx) => {
      console.error("questions.addResponseOption failed", e);
      notify.error(e.message);
      if (ctx?.tempId) {
        setDetail((d) => ({
          ...d,
          options: d.options.filter((o) => o.responseOptionId !== ctx.tempId),
        }));
      }
    },
  });

  const removeOption = useMutation({
    mutationFn: (responseOptionId: string) =>
      client.questions.removeResponseOption({ questionId, responseOptionId }),
    onSettled: refreshQuestionProjections,
    onMutate: (responseOptionId) => {
      const prev = queryClient.getQueryData<QuestionDetail>(["question", questionId]);
      setDetail((d) => ({
        ...d,
        options: d.options.filter((o) => o.responseOptionId !== responseOptionId),
      }));
      return { prev };
    },
    onError: (e, _id, ctx) => {
      console.error("questions.removeResponseOption failed", e);
      notify.error(e.message);
      if (ctx?.prev) queryClient.setQueryData(["question", questionId], ctx.prev);
    },
  });

  const reorderOptions = useMutation({
    mutationFn: (ids: string[]) =>
      client.questions.reorderResponseOptions({
        questionId,
        responseOptionIds: ids,
      }),
    onSettled: refreshQuestionProjections,
    onError: (e) => {
      console.error("questions.reorderResponseOptions failed", e);
      notify.error(e.message);
      void queryClient.invalidateQueries({
        queryKey: ["question", questionId],
      });
    },
  });

  const updateOptionText = useMutation({
    mutationFn: (input: { responseOptionId: string; text: string }) =>
      client.questions.updateResponseOptionText({ questionId, ...input }),
    onSettled: refreshQuestionProjections,
    onMutate: ({ responseOptionId, text }) => {
      setDetail((d) => ({
        ...d,
        options: d.options.map((o) =>
          o.responseOptionId === responseOptionId ? { ...o, text } : o,
        ),
      }));
    },
    onError: (e) => {
      console.error("questions.updateResponseOptionText failed", e);
      notify.error(e.message);
      void queryClient.invalidateQueries({
        queryKey: ["question", questionId],
      });
    },
  });

  // Write the optimistic order to the cache on every reorder tick so any
  // observer of `questionDetailQuery` (the script-editor preview)
  // updates live during drag. baselineOrderRef captures the pre-drag
  // order on the first tick; drag-end compares against it to skip the
  // mutation when the user releases at the original position.
  const baselineOrderRef = useRef<string[] | null>(null);

  const handleOptionsReorder = (next: ResponseOption[]) => {
    if (baselineOrderRef.current === null && question) {
      baselineOrderRef.current = question.options.map((o) => o.responseOptionId);
    }
    setDetail((d) => ({ ...d, options: next.map((o, i) => ({ ...o, order: i })) }));
  };

  const handleOptionsDragEnd = () => {
    const baseline = baselineOrderRef.current;
    baselineOrderRef.current = null;
    if (!baseline || !question) return;
    const newOrder = question.options.map((o) => o.responseOptionId);
    const changed =
      baseline.length !== newOrder.length || newOrder.some((id, i) => id !== baseline[i]);
    if (changed) reorderOptions.mutate(newOrder);
  };

  if (!question) return null;

  // Open-ended questions have no options — canvassers type the answer.
  if (question.responseType === "open_ended") {
    return (
      <span className="text-sm text-muted-foreground italic">
        Answers are typed in by the canvasser
      </span>
    );
  }

  return (
    <div className="flex flex-col gap-1.5">
      {question.options.length === 0 ? null : (
        <Reorder.Group
          axis="y"
          values={question.options}
          onReorder={handleOptionsReorder}
          as="div"
          className="flex flex-col gap-1.5"
        >
          {question.options.map((opt) => (
            <ReorderOptionRow
              key={opt.responseOptionId}
              option={opt}
              onChangeText={(text) =>
                updateOptionText.mutate({
                  responseOptionId: opt.responseOptionId,
                  text,
                })
              }
              onRemove={() => removeOption.mutate(opt.responseOptionId)}
              onDragEnd={handleOptionsDragEnd}
              isNew={!isPreExisting(opt.responseOptionId)}
            />
          ))}
        </Reorder.Group>
      )}
      <motion.div
        ref={optionsEndRef}
        layout
        transition={{ type: "tween", duration: 0.15, ease: "easeOut" }}
        onLayoutAnimationComplete={() => {
          if (!justAddedRef.current) return;
          justAddedRef.current = false;
          optionsEndRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
        }}
        className="flex scroll-mb-[18px] items-center gap-1.5"
      >
        <Button
          variant="outline"
          size="sm"
          press="none"
          className="h-8 flex-1 justify-start bg-card dark:bg-card"
          onClick={() => addOption.mutate()}
          loading={addOption.isPending}
        >
          <Icon name="plus" className="-ml-0.5 mr-0.5" />
          Add option
        </Button>
        <span aria-hidden className="w-6 shrink-0" />
      </motion.div>
    </div>
  );
}

function ReorderOptionRow({
  onDragEnd,
  ...props
}: {
  option: ResponseOption;
  onChangeText: (text: string) => void;
  onRemove: () => void;
  onDragEnd?: () => void;
  isNew: boolean;
}) {
  const controls = useDragControls();
  return (
    <Reorder.Item
      value={props.option}
      dragListener={false}
      dragControls={controls}
      as="div"
      onDragEnd={onDragEnd}
      transition={{ layout: { type: "tween", duration: 0.15, ease: "easeOut" } }}
      dragTransition={{ bounceStiffness: 10000, bounceDamping: 500, power: 0 }}
    >
      <OptionRow {...props} dragControls={controls} />
    </Reorder.Item>
  );
}

function OptionRow({
  option,
  onChangeText,
  onRemove,
  dragControls,
  isNew,
}: {
  option: ResponseOption;
  onChangeText: (text: string) => void;
  onRemove: () => void;
  dragControls?: ReturnType<typeof useDragControls>;
  isNew: boolean;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <div className="relative flex-1 min-w-0">
        <button
          type="button"
          className="absolute left-2 top-1/2 -translate-y-1/2 cursor-grab touch-none text-muted-foreground/40 hover:text-muted-foreground"
          onPointerDown={(e) => dragControls?.start(e)}
          aria-label="Drag to reorder"
        >
          <Icon name="grip-vertical" className="size-3.5" />
        </button>
        <BlurSaveInput
          value={option.text}
          onCommit={onChangeText}
          className="h-8 w-full pl-7"
          placeholder="Option text"
        />
      </div>
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={onRemove}
        onMouseDown={(e) => e.preventDefault()}
        aria-label="Remove option"
        className={cn("h-8 w-6", isNew && "animate-in fade-in duration-200")}
      >
        <Icon name="x" className="size-4 text-muted-foreground" />
      </Button>
    </div>
  );
}

export function BlurSaveInput({
  value,
  onCommit,
  className,
  placeholder,
}: {
  value: string;
  onCommit: (text: string) => void;
  className?: string;
  placeholder?: string;
}) {
  const [local, setLocal] = useState(value);
  useEffect(() => {
    setLocal(value);
  }, [value]);
  return (
    <Input
      value={local}
      onChange={(e) => setLocal(e.target.value)}
      onBlur={() => {
        if (local !== value) onCommit(local);
      }}
      onKeyDown={(e) => {
        // Enter commits (blur runs save). If we're inside a Dialog,
        // also refocus the popup so a subsequent Enter can dismiss via
        // the popup's built-in handler. No-op outside a dialog.
        if (e.key === "Enter") {
          const target = e.currentTarget as HTMLInputElement;
          target.blur();
          target.closest<HTMLElement>('[role="dialog"]')?.focus();
        }
      }}
      placeholder={placeholder}
      className={className}
    />
  );
}

export function BlurSaveTextarea({
  value,
  onCommit,
  placeholder,
  rows,
}: {
  value: string;
  onCommit: (text: string) => void;
  placeholder?: string;
  rows?: number;
}) {
  const [local, setLocal] = useState(value);
  useEffect(() => {
    setLocal(value);
  }, [value]);
  return (
    <textarea
      value={local}
      onChange={(e) => setLocal(e.target.value)}
      onBlur={() => {
        if (local !== value) onCommit(local);
      }}
      onKeyDown={(e) => {
        // Cmd/Ctrl+Enter commits (blur runs save). Plain Enter inserts
        // a newline as expected for a textarea. If we're inside a Dialog
        // popup, also refocus the popup itself after blur so the popup's
        // built-in Enter handler can pick up a subsequent Enter to dismiss.
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          const target = e.currentTarget as HTMLTextAreaElement;
          target.blur();
          const popup = target.closest<HTMLElement>('[role="dialog"]');
          popup?.focus();
        }
      }}
      placeholder={placeholder}
      rows={rows}
      className={cn(
        "block w-full resize-y rounded-md border border-border bg-card px-3 py-2 text-sm",
        "placeholder:text-muted-foreground",
        "focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50",
        "outline-none",
      )}
    />
  );
}
