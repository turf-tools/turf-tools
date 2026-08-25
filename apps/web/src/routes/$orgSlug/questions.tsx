import { Icon } from "~/components/icon";
import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { notify } from "~/lib/notify";
import { tintStyle } from "~/components/badge";
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
  type ResponseType,
  ResponseTypePicker,
} from "~/components/question-editor-parts";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "~/components/table";
import {
  seedQuestionDetail,
  questionDetailQuery,
  questionsListQuery,
} from "~/lib/queries/questions";
import { GRAY } from "~/lib/palette";
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
    const rows = await queryClient.fetchQuery(questionsListQuery(deps.status));
    // Pre-warm each row's detail cache so opening the edit modal hits
    // warm cache and renders the full form (including options) without
    // a fan-in flash. N parallel queries — cheap at our scale.
    await Promise.all(
      rows.map((r) => queryClient.prefetchQuery(questionDetailQuery(r.questionId))),
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

  // `null` = closed, `"new"` = create dialog, anything else = a questionId being edited.
  const [editing, setEditing] = useState<string | null>(null);

  return (
    <Page className={cn("flex h-[calc(100vh-3.5rem)] flex-col", shouldFade)}>
      <EditorHeader title="Questions">
        <Filter
          icon={<Icon name="activity" className="size-3.5" />}
          label={statusLabel}
          value={filterValue}
          options={STATUS_OPTIONS}
          allLabel="Active"
          onChange={onStatusChange}
        />
        <Button onClick={() => setEditing("new")}>
          <Icon name="plus" />
          New question
        </Button>
      </EditorHeader>
      <QuestionsTable status={status} onEdit={(id) => setEditing(id)} />
      {editing !== null ? (
        <QuestionModal
          initialQuestionId={editing === "new" ? null : editing}
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
  onEdit: (questionId: string) => void;
}) {
  const { data: rows } = useSuspenseQuery(questionsListQuery(status));

  return (
    <Table containerClassName="min-h-0 flex-1 overflow-y-auto" className="table-fixed">
      <TableHeader className="[&_th]:sticky [&_th]:top-0 [&_th]:z-10 [&_th]:bg-background">
        <TableRow>
          <TableHead className="w-72">Name</TableHead>
          <TableHead className="w-36">Type</TableHead>
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
          <QuestionRow key={q.questionId} question={q} onEdit={() => onEdit(q.questionId)} />
        ))}
      </TableBody>
    </Table>
  );
}

type QuestionListRow = Awaited<ReturnType<typeof client.questions.list>>[number];

function QuestionRow({ question, onEdit }: { question: QuestionListRow; onEdit: () => void }) {
  const queryClient = useQueryClient();
  const archived = question.archivedAt != null;

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["questions"] });

  const archive = useMutation({
    mutationFn: () => client.questions.archive({ questionId: question.questionId }),
    onSuccess: ({ affectedScriptIds }) => {
      void invalidate();
      // Targeted invalidation per script the question was removed from —
      // avoids nuking unrelated open-script caches.
      for (const scriptId of affectedScriptIds) {
        void queryClient.invalidateQueries({ queryKey: ["script", scriptId] });
      }
    },
    onError: (e) => notify.error(e.message),
  });
  const unarchive = useMutation({
    mutationFn: () => client.questions.unarchive({ questionId: question.questionId }),
    onSuccess: invalidate,
    onError: (e) => notify.error(e.message),
  });

  const [archiveDialogOpen, setArchiveDialogOpen] = useState(false);
  const meta = RESPONSE_TYPE_META[question.responseType] ?? {
    label: question.responseType,
    color: GRAY,
  };

  return (
    <>
      <TableRow className={cn(archived && "text-muted-foreground")}>
        <TableCell>
          {archived ? (
            <Pill className="min-w-0">
              <span className="truncate">{question.name}</span>
            </Pill>
          ) : (
            <Button variant="outline" className="w-full justify-start" onClick={onEdit}>
              <Icon name="pencil" className="size-3.5" />
              <span className="truncate">{question.name}</span>
            </Button>
          )}
        </TableCell>
        <TableCell>
          <Pill color={meta.color}>
            <span className="truncate">{meta.label}</span>
          </Pill>
        </TableCell>

        <TableCell>
          <Pill className="min-w-0">
            <span className="truncate italic text-muted-foreground pr-0.5">
              {question.text || "—"}
            </span>
          </Pill>
        </TableCell>
        <TableCell>
          <Pill variant="number">{question.usedCount}</Pill>
        </TableCell>
        <TableCell>
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
      <DropdownMenuTrigger render={<Button variant="outline" size="icon" className="h-8 w-full" />}>
        <Icon name="more-horizontal" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        {archived ? (
          <DropdownMenuItem onClick={onUnarchive}>
            <Icon name="archive-restore" />
            Unarchive
          </DropdownMenuItem>
        ) : (
          <>
            <DropdownMenuItem onClick={onEdit}>
              <Icon name="pencil" />
              Edit
            </DropdownMenuItem>
            <DropdownMenuItem variant="destructive" onClick={onArchive}>
              <Icon name="archive" />
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
  initialQuestionId,
  onClose,
}: {
  initialQuestionId: string | null;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [createdId, setCreatedId] = useState<string | null>(null);
  const questionId = initialQuestionId ?? createdId;

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent className="max-w-xl">
        {questionId === null ? (
          <CreateBody
            onCreated={(question) => {
              seedQuestionDetail(queryClient, question);
              void queryClient.invalidateQueries({ queryKey: ["questions"] });
              setCreatedId(question.questionId);
            }}
          />
        ) : (
          <EditBody questionId={questionId} />
        )}
      </DialogContent>
    </Dialog>
  );
}

function CreateBody({
  onCreated,
}: {
  onCreated: (question: Awaited<ReturnType<typeof client.questions.create>>) => void;
}) {
  const [name, setName] = useState("");
  const [responseType, setResponseType] = useState<ResponseType>("single_select");

  const create = useMutation({
    mutationFn: (input: { name: string; responseType: ResponseType }) =>
      client.questions.create(input),
    onSuccess: onCreated,
    onError: (e) => notify.error(e.message),
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
          <ResponseTypePicker
            value={responseType}
            onChange={setResponseType}
            disabled={create.isPending}
          />
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

function EditBody({ questionId }: { questionId: string }) {
  const queryClient = useQueryClient();
  const { data: question } = useQuery(questionDetailQuery(questionId));

  const rename = useMutation({
    mutationFn: (name: string) => client.questions.rename({ questionId, name }),
    onMutate: (name) => {
      const key = ["question", questionId];
      const prev = queryClient.getQueryData<typeof question>(key);
      queryClient.setQueryData<typeof question>(key, (old) => (old ? { ...old, name } : old));
      return { prev };
    },
    onError: (e, _name, ctx) => {
      notify.error(e.message);
      if (ctx?.prev) queryClient.setQueryData(["question", questionId], ctx.prev);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["questions"] });
    },
  });

  if (!question) return null;
  const meta = RESPONSE_TYPE_META[question.responseType] ?? {
    label: question.responseType,
    color: GRAY,
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
            className="badge-tint inline-flex h-8 w-fit items-center rounded-md px-2 text-sm"
            style={tintStyle(meta.color)}
          >
            {meta.label}
          </span>
        </div>
        <div className="flex flex-col gap-1.5">
          <label className="text-sm text-muted-foreground">Question text</label>
          <QuestionTextEditor questionId={questionId} />
        </div>
        <div className="flex flex-col gap-2">
          <label className="text-sm text-muted-foreground">Responses</label>
          <ResponseOptionsEditor questionId={questionId} />
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
