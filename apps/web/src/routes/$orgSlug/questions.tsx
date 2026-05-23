import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import {
  Activity,
  Archive,
  ArchiveRestore,
  ChevronDown,
  MoreHorizontal,
  Pencil,
  Plus,
} from "lucide-react";
import { useEffect, useState } from "react";
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
  DropdownMenuTrigger,
} from "~/components/dropdown-menu";
import { EditorHeader } from "~/components/editor-header";
import { Filter } from "~/components/filter";
import { Input } from "~/components/input";
import { Page } from "~/components/page";
import { Pill } from "~/components/pill";
import {
  QuestionTextEditor,
  RESPONSE_TYPE_META,
  ResponseOptionsEditor,
} from "~/components/question-editor-parts";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "~/components/table";
import {
  seedQuestionDetail,
  surveyQuestionDetailQuery,
  surveyQuestionsListQuery,
} from "~/lib/queries/survey-questions";
import { useFadeOnce } from "~/lib/use-fade-once";
import { cn } from "~/lib/utils";
import { client } from "~/rpc/client";

type QuestionsSearch = {
  status: "active" | "archived" | "all";
};

const STATUS_OPTIONS = [
  { value: "archived", label: "Archived" },
  { value: "all", label: "All statuses" },
];

export const Route = createFileRoute("/$orgSlug/questions")({
  validateSearch: (search): QuestionsSearch => {
    const s = search.status;
    return {
      status: s === "archived" || s === "all" ? s : "active",
    };
  },
  loaderDeps: ({ search }) => ({ status: search.status }),
  loader: async ({ context: { queryClient }, deps }) => {
    const rows = await queryClient.fetchQuery(surveyQuestionsListQuery(deps.status));
    // Pre-warm each row's detail cache so opening the edit modal hits
    // warm cache and renders the full form (including options) without
    // a fan-in flash. N parallel queries — cheap at our scale.
    await Promise.all(
      rows.map((r) => queryClient.prefetchQuery(surveyQuestionDetailQuery(r.surveyQuestionId))),
    );
  },
  component: QuestionsPage,
});

function QuestionsPage() {
  const { status } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const shouldFade = useFadeOnce("/questions");

  // null in URL = "active" (the default). The Filter helper maps null →
  // its allLabel option; we translate between that and the search param.
  const filterValue = status === "active" ? null : status;
  const onStatusChange = (next: string | null) =>
    void navigate({
      search: () => ({ status: (next ?? "active") as QuestionsSearch["status"] }),
    });
  const statusLabel =
    filterValue === null
      ? "Active"
      : (STATUS_OPTIONS.find((o) => o.value === filterValue)?.label ?? "Active");

  // `null` = closed, `"new"` = create dialog, anything else = a surveyQuestionId being edited.
  const [editing, setEditing] = useState<string | null>(null);

  return (
    <Page className={shouldFade}>
      <EditorHeader title="Questions">
        <Filter
          icon={<Activity className="size-3.5" />}
          label={statusLabel}
          value={filterValue}
          options={STATUS_OPTIONS}
          allLabel="Active"
          onChange={onStatusChange}
        />
        <Button onClick={() => setEditing("new")}>
          <Plus />
          New question
        </Button>
      </EditorHeader>
      <QuestionsTable status={status} onEdit={(id) => setEditing(id)} />
      {editing !== null ? (
        <QuestionModal
          initialSurveyQuestionId={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </Page>
  );
}

function QuestionsTable({
  status,
  onEdit,
}: {
  status: QuestionsSearch["status"];
  onEdit: (surveyQuestionId: string) => void;
}) {
  const { data: rows } = useSuspenseQuery(surveyQuestionsListQuery(status));

  return (
    <Table containerClassName="h-[calc(100vh-9rem)] overflow-y-auto" className="table-fixed">
      <TableHeader className="[&_th]:sticky [&_th]:top-0 [&_th]:z-10 [&_th]:bg-background">
        <TableRow>
          <TableHead className="w-36">Type</TableHead>
          <TableHead className="w-56">Name</TableHead>
          <TableHead>Text</TableHead>
          <TableHead className="w-24">Used in</TableHead>
          <TableHead className="w-11" />
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.length === 0 ? (
          <TableRow className="h-10">
            <TableCell colSpan={5}>
              <Pill>
                <span>No questions</span>
              </Pill>
            </TableCell>
          </TableRow>
        ) : null}
        {rows.map((q) => (
          <QuestionRow
            key={q.surveyQuestionId}
            question={q}
            onEdit={() => onEdit(q.surveyQuestionId)}
          />
        ))}
      </TableBody>
    </Table>
  );
}

type QuestionListRow = Awaited<ReturnType<typeof client.surveyQuestions.list>>[number];

function QuestionRow({ question, onEdit }: { question: QuestionListRow; onEdit: () => void }) {
  const queryClient = useQueryClient();
  const archived = question.archivedAt != null;

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["survey-questions"] });

  const archive = useMutation({
    mutationFn: () =>
      client.surveyQuestions.archive({ surveyQuestionId: question.surveyQuestionId }),
    onSuccess: ({ affectedScriptIds }) => {
      void invalidate();
      // Targeted invalidation per script the question was removed from —
      // avoids nuking unrelated open-script caches.
      for (const scriptId of affectedScriptIds) {
        void queryClient.invalidateQueries({ queryKey: ["script", scriptId] });
      }
    },
    onError: (e) => toast.error(e.message),
  });
  const unarchive = useMutation({
    mutationFn: () =>
      client.surveyQuestions.unarchive({ surveyQuestionId: question.surveyQuestionId }),
    onSuccess: invalidate,
    onError: (e) => toast.error(e.message),
  });

  const [archiveDialogOpen, setArchiveDialogOpen] = useState(false);
  const meta = RESPONSE_TYPE_META[question.responseType] ?? {
    label: question.responseType,
    color: "#9ca3af",
  };

  return (
    <>
      <TableRow
        onClick={archived ? undefined : onEdit}
        className={cn(archived ? "text-muted-foreground" : "group cursor-pointer")}
      >
        <TableCell>
          <span
            // Drive bg via Tailwind class + CSS var so the hover state
            // can override (inline-style bg would always win). Text color
            // stays untouched.
            className={cn(
              "flex h-8 w-full items-center rounded-md border border-transparent bg-clip-padding px-2 text-sm",
            )}
            style={{ backgroundColor: `${meta.color}22`, color: meta.color }}
          >
            <span className="truncate">{meta.label}</span>
          </span>
        </TableCell>
        <TableCell>
          <Pill className="min-w-0 group-hover:bg-muted-foreground/15">
            <span className="truncate">{question.name}</span>
          </Pill>
        </TableCell>

        <TableCell>
          <Pill className="min-w-0 group-hover:bg-muted-foreground/15">
            <span className="truncate italic text-muted-foreground pr-0.5">
              {question.text || "—"}
            </span>
          </Pill>
        </TableCell>
        <TableCell>
          <Pill variant="number" className="group-hover:bg-muted-foreground/15">
            {question.usedCount}
          </Pill>
        </TableCell>
        <TableCell onClick={(e) => e.stopPropagation()}>
          <RowMenu
            archived={archived}
            onEdit={onEdit}
            onArchive={() => {
              if (question.usedCount > 0) {
                setArchiveDialogOpen(true);
              } else {
                archive.mutate();
              }
            }}
            onUnarchive={() => unarchive.mutate()}
          />
        </TableCell>
      </TableRow>
      <ArchiveQuestionDialog
        open={archiveDialogOpen}
        onOpenChange={setArchiveDialogOpen}
        questionName={question.name}
        usedCount={question.usedCount}
        pending={archive.isPending}
        onConfirm={() => {
          archive.mutate(undefined, { onSuccess: () => setArchiveDialogOpen(false) });
        }}
      />
    </>
  );
}

function RowMenu({
  archived,
  onEdit,
  onArchive,
  onUnarchive,
}: {
  archived: boolean;
  onEdit: () => void;
  onArchive: () => void;
  onUnarchive: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            className={cn(
              "w-full bg-muted group-hover:bg-muted-foreground/15 hover:bg-foreground/8",
              "aria-expanded:bg-foreground/8",
            )}
          />
        }
      >
        <MoreHorizontal />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        {archived ? (
          <DropdownMenuItem onClick={onUnarchive}>
            <ArchiveRestore />
            Unarchive
          </DropdownMenuItem>
        ) : (
          <>
            <DropdownMenuItem onClick={onEdit}>
              <Pencil />
              Edit
            </DropdownMenuItem>
            <DropdownMenuItem variant="destructive" onClick={onArchive}>
              <Archive />
              Archive
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ArchiveQuestionDialog({
  open,
  onOpenChange,
  questionName,
  usedCount,
  pending,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  questionName: string;
  usedCount: number;
  pending: boolean;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogTitle>Archive question?</DialogTitle>
        <DialogDescription>
          <span className="font-medium text-foreground">{questionName}</span> is used in{" "}
          <span className="font-bold text-foreground">{usedCount}</span> script step
          {usedCount === 1 ? "" : "s"}. Archiving removes it from those scripts. Historical
          responses keep their reference.
        </DialogDescription>
        <div className="mt-2 flex justify-end gap-2">
          <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
          <Button variant="destructive" onClick={onConfirm} loading={pending}>
            Archive
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// One Dialog wraps both create and edit phases so the overlay doesn't
// flash on the create → edit handoff.
function QuestionModal({
  initialSurveyQuestionId,
  onClose,
}: {
  initialSurveyQuestionId: string | null;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [createdId, setCreatedId] = useState<string | null>(null);
  const surveyQuestionId = initialSurveyQuestionId ?? createdId;

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent className="max-w-xl">
        {surveyQuestionId === null ? (
          <CreateBody
            onCreated={(question) => {
              seedQuestionDetail(queryClient, question);
              void queryClient.invalidateQueries({ queryKey: ["survey-questions"] });
              setCreatedId(question.surveyQuestionId);
            }}
          />
        ) : (
          <EditBody surveyQuestionId={surveyQuestionId} />
        )}
      </DialogContent>
    </Dialog>
  );
}

function CreateBody({
  onCreated,
}: {
  onCreated: (question: Awaited<ReturnType<typeof client.surveyQuestions.create>>) => void;
}) {
  const [name, setName] = useState("");
  const [responseType, setResponseType] = useState<"single_select">("single_select");

  const create = useMutation({
    mutationFn: (input: { name: string; responseType: "single_select" }) =>
      client.surveyQuestions.create(input),
    onSuccess: onCreated,
    onError: (e) => toast.error(e.message),
  });

  const valid = name.trim().length > 0;

  return (
    <>
      <DialogTitle>Create new question</DialogTitle>
      <DialogDescription>
        Pick a short name and the type of question. You'll edit the full text and responses next.
      </DialogDescription>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!valid || create.isPending) return;
          create.mutate({ name: name.trim(), responseType });
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
            disabled={create.isPending}
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
                  disabled={create.isPending}
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
        <div className="mt-2 flex justify-end gap-2">
          <DialogClose render={<Button variant="outline" type="button" />}>Cancel</DialogClose>
          <Button type="submit" disabled={!valid} loading={create.isPending}>
            Create
          </Button>
        </div>
      </form>
    </>
  );
}

function EditBody({ surveyQuestionId }: { surveyQuestionId: string }) {
  const queryClient = useQueryClient();
  const { data: question } = useQuery(surveyQuestionDetailQuery(surveyQuestionId));

  const rename = useMutation({
    mutationFn: (name: string) => client.surveyQuestions.rename({ surveyQuestionId, name }),
    onMutate: (name) => {
      const key = ["survey-question", surveyQuestionId];
      const prev = queryClient.getQueryData<typeof question>(key);
      queryClient.setQueryData<typeof question>(key, (old) => (old ? { ...old, name } : old));
      return { prev };
    },
    onError: (e, _name, ctx) => {
      toast.error(e.message);
      if (ctx?.prev) queryClient.setQueryData(["survey-question", surveyQuestionId], ctx.prev);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["survey-questions"] });
    },
  });

  if (!question) return null;
  const meta = RESPONSE_TYPE_META[question.responseType] ?? {
    label: question.responseType,
    color: "#9ca3af",
  };

  return (
    <>
      <DialogTitle>Edit question</DialogTitle>
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <label className="text-sm text-muted-foreground">Name</label>
          <EditNameInput value={question.name} onCommit={(name) => rename.mutate(name)} />
        </div>
        <div className="flex flex-col gap-1.5">
          <label className="text-sm text-muted-foreground">Type</label>
          <span
            className="inline-flex h-8 w-fit items-center rounded-md px-2 text-sm"
            style={{ backgroundColor: `${meta.color}22`, color: meta.color }}
          >
            {meta.label}
          </span>
        </div>
        <div className="flex flex-col gap-1.5">
          <label className="text-sm text-muted-foreground">Question text</label>
          <QuestionTextEditor surveyQuestionId={surveyQuestionId} />
        </div>
        <div className="flex flex-col gap-2">
          <label className="text-sm text-muted-foreground">Responses</label>
          <ResponseOptionsEditor surveyQuestionId={surveyQuestionId} />
        </div>
        <div className="mt-2 flex justify-end">
          <DialogClose render={<Button />}>Done</DialogClose>
        </div>
      </div>
    </>
  );
}

function EditNameInput({ value, onCommit }: { value: string; onCommit: (text: string) => void }) {
  const [local, setLocal] = useState(value);
  useEffect(() => {
    setLocal(value);
  }, [value]);
  return (
    <Input
      value={local}
      onChange={(e) => setLocal(e.target.value)}
      onBlur={() => {
        const trimmed = local.trim();
        if (trimmed && trimmed !== value) onCommit(trimmed);
        else setLocal(value);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          const target = e.currentTarget as HTMLInputElement;
          target.blur();
          target.closest<HTMLElement>('[role="dialog"]')?.focus();
        }
      }}
    />
  );
}
