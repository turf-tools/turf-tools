import { Icon } from "~/components/icon";
import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
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
import type { IconName } from "~/lib/icon-names";
import { GRAY } from "~/lib/palette";
import { useFadeOnce } from "~/lib/use-fade-once";
import { cn } from "~/lib/utils";
import { client } from "~/rpc/client";
import type { ScriptRef } from "~/rpc/web/questions";

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
  const queryClient = useQueryClient();
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

  const [modal, setModal] = useState<ModalState>(null);

  // The loader's detail prefetches have no observers here, so they go stale
  // and get garbage-collected while the page sits open. Fetching on click
  // (instant when fresh) keeps the editor from opening empty or with an
  // outdated lock state.
  const openEdit = async (questionId: string) => {
    try {
      await queryClient.fetchQuery(questionDetailQuery(questionId));
    } catch (e) {
      notify.error(e instanceof Error ? e.message : String(e));
      return;
    }
    setModal({ kind: "edit", questionId });
  };

  return (
    <Page className={cn("flex h-[calc(100vh-3.5rem)] flex-col", shouldFade)}>
      <EditorHeader title="Questions" subtitle="Create and edit script components">
        <Filter
          icon={<Icon name="activity" className="size-3.5" />}
          label={statusLabel}
          value={filterValue}
          options={STATUS_OPTIONS}
          allLabel="Active"
          onChange={onStatusChange}
        />
        <Button onClick={() => setModal({ kind: "new" })}>
          <Icon name="plus" />
          New question
        </Button>
      </EditorHeader>
      <QuestionsTable
        status={status}
        onEdit={(questionId) => void openEdit(questionId)}
        onClone={(source) => setModal({ kind: "clone", source })}
      />
      {modal !== null ? (
        <QuestionModal
          initialQuestionId={modal.kind === "edit" ? modal.questionId : null}
          source={modal.kind === "clone" ? modal.source : null}
          onClose={() => setModal(null)}
        />
      ) : null}
    </Page>
  );
}

type CloneSource = { questionId: string; name: string };

type ModalState =
  | null
  | { kind: "new" }
  | { kind: "clone"; source: CloneSource }
  | { kind: "edit"; questionId: string };

function QuestionsTable({
  status,
  onEdit,
  onClone,
}: {
  status: QuestionsSearch["status"];
  onEdit: (questionId: string) => void;
  onClone: (source: CloneSource) => void;
}) {
  const { data: rows } = useSuspenseQuery(questionsListQuery(status));

  return (
    <Table containerClassName="min-h-0 flex-1 overflow-y-auto" className="table-fixed">
      <TableHeader className="[&_th]:sticky [&_th]:top-0 [&_th]:z-10 [&_th]:bg-background">
        <TableRow>
          <TableHead className="w-72">Name</TableHead>
          <TableHead className="w-36">Type</TableHead>
          <TableHead>Text</TableHead>
          <TableHead className="w-22">Options</TableHead>
          <TableHead className="w-22">Used in</TableHead>
          <TableHead className="w-22">Locked</TableHead>
          <TableHead className="w-9" />
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.length === 0 ? (
          <TableRow className="h-10">
            <TableCell colSpan={7}>
              <Pill>
                <span>No questions</span>
              </Pill>
            </TableCell>
          </TableRow>
        ) : null}
        {rows.map((q) => (
          <QuestionRow
            key={q.questionId}
            question={q}
            onEdit={() => onEdit(q.questionId)}
            onClone={() => onClone(q)}
          />
        ))}
      </TableBody>
    </Table>
  );
}

type QuestionListRow = Awaited<ReturnType<typeof client.questions.list>>[number];

function QuestionRow({
  question,
  onEdit,
  onClone,
}: {
  question: QuestionListRow;
  onEdit: () => void;
  onClone: () => void;
}) {
  const queryClient = useQueryClient();
  const archived = question.archivedAt != null;
  const locked = question.lockedBy.length > 0;
  // Snapshotted so the dialog body holds through its close animation.
  const [scriptsOpen, setScriptsOpen] = useState(false);
  const [scriptsSnapshot, setScriptsSnapshot] = useState<{
    kind: "used" | "locked";
    scripts: ScriptRef[];
  }>({ kind: "used", scripts: [] });
  const openScripts = (kind: "used" | "locked", scripts: ScriptRef[]) => {
    setScriptsSnapshot({ kind, scripts });
    setScriptsOpen(true);
  };
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [optionsSnapshot, setOptionsSnapshot] = useState<
    { responseOptionId: string; text: string }[]
  >([]);
  // Details are fetched on click (instant when fresh) so the list is current.
  const openOptions = async () => {
    try {
      const detail = await queryClient.fetchQuery(questionDetailQuery(question.questionId));
      setOptionsSnapshot(detail?.options ?? []);
    } catch (e) {
      notify.error(e instanceof Error ? e.message : String(e));
      return;
    }
    setOptionsOpen(true);
  };

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
  // Click-time freshness probe drives the gate; snapshotted so the dialog
  // keeps its body during the close animation.
  const [archivePrompt, setArchivePrompt] = useState<{
    gatesSteps: boolean;
    usedCount: number;
  } | null>(null);

  const requestArchive = async () => {
    let usage: Awaited<ReturnType<typeof client.questions.liveUsage>>;
    try {
      usage = await queryClient.fetchQuery({
        queryKey: ["question-live-usage", question.questionId],
        queryFn: () => client.questions.liveUsage({ questionId: question.questionId }),
        staleTime: 0,
      });
    } catch (e) {
      notify.error(e instanceof Error ? e.message : String(e));
      return;
    }
    if (usage.gatingOptionIds.length > 0 || usage.usedCount > 0) {
      setArchivePrompt({
        gatesSteps: usage.gatingOptionIds.length > 0,
        usedCount: usage.usedCount,
      });
      setArchiveDialogOpen(true);
    } else {
      archive.mutate();
    }
  };

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
            <Button
              variant="outline"
              className="w-full justify-start"
              onClick={onEdit}
              disabled={locked}
            >
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
          <CountButton
            icon="list"
            count={question.optionCount}
            onClick={() => void openOptions()}
          />
        </TableCell>
        <TableCell>
          <CountButton
            icon="clipboard-pen"
            count={question.usedBy.length}
            onClick={() => openScripts("used", question.usedBy)}
          />
        </TableCell>
        <TableCell>
          <CountButton
            icon="lock"
            count={question.lockedBy.length}
            onClick={() => openScripts("locked", question.lockedBy)}
          />
        </TableCell>
        <TableCell>
          <RowMenu
            archived={archived}
            locked={locked}
            onEdit={onEdit}
            onClone={onClone}
            onArchive={() => void requestArchive()}
            onUnarchive={() => unarchive.mutate()}
          />
        </TableCell>
      </TableRow>
      <ArchiveQuestionDialog
        open={archiveDialogOpen}
        onOpenChange={setArchiveDialogOpen}
        questionName={question.name}
        usedCount={archivePrompt?.usedCount ?? question.usedBy.length}
        gatesSteps={archivePrompt?.gatesSteps ?? false}
        pending={archive.isPending}
        onConfirm={() => {
          archive.mutate(undefined, { onSuccess: () => setArchiveDialogOpen(false) });
        }}
      />
      <OptionsDialog
        open={optionsOpen}
        onOpenChange={setOptionsOpen}
        questionName={question.name}
        options={optionsSnapshot}
      />
      <ScriptsDialog
        open={scriptsOpen}
        onOpenChange={setScriptsOpen}
        questionName={question.name}
        kind={scriptsSnapshot.kind}
        scripts={scriptsSnapshot.scripts}
      />
    </>
  );
}

// An icon and count that opens a detail dialog; an empty pill at zero.
function CountButton({
  icon,
  count,
  onClick,
}: {
  icon: IconName;
  count: number;
  onClick: () => void;
}) {
  if (count === 0) return <Pill />;
  return (
    <Button variant="outline" className="w-full justify-start" onClick={onClick}>
      <Icon name={icon} className="size-3.5" />
      <span className="font-mono tabular-nums">{count}</span>
    </Button>
  );
}

function RowMenu({
  archived,
  locked,
  onEdit,
  onClone,
  onArchive,
  onUnarchive,
}: {
  archived: boolean;
  locked: boolean;
  onEdit: () => void;
  onClone: () => void;
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
            <DropdownMenuItem onClick={onEdit} disabled={locked}>
              <Icon name="pencil" />
              Edit
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onClone}>
              <Icon name="copy" />
              Clone
            </DropdownMenuItem>
            <DropdownMenuItem variant="destructive" onClick={onArchive} disabled={locked}>
              <Icon name="archive" />
              Archive
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function OptionsDialog({
  open,
  onOpenChange,
  questionName,
  options,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  questionName: string;
  options: { responseOptionId: string; text: string }[];
}) {
  const n = options.length;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogTitle>Options</DialogTitle>
        <DialogDescription className="mb-4">
          The question <span className="font-medium text-foreground">{questionName}</span> has{" "}
          <span className="font-bold text-foreground">{n}</span> option{n === 1 ? "" : "s"}.
        </DialogDescription>
        <div className="flex flex-col gap-1.5">
          {options.map((o) => (
            <Pill key={o.responseOptionId} className="min-w-0">
              {o.text ? (
                <span className="truncate">{o.text}</span>
              ) : (
                <span className="italic text-muted-foreground">Empty option</span>
              )}
            </Pill>
          ))}
        </div>
        <div className="mt-5 flex justify-end">
          <DialogClose render={<Button variant="outline" />}>Close</DialogClose>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// The scripts using a question (`used`) or the locked ones among them
// (`locked`), as links to each script.
function ScriptsDialog({
  open,
  onOpenChange,
  questionName,
  kind,
  scripts,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  questionName: string;
  kind: "used" | "locked";
  scripts: ScriptRef[];
}) {
  const { orgSlug } = Route.useParams();
  const n = scripts.length;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogTitle>{kind === "locked" ? "Question locked" : "Used in"}</DialogTitle>
        <DialogDescription className="mb-4">
          The question <span className="font-medium text-foreground">{questionName}</span> is used
          in <span className="font-bold text-foreground">{n}</span> script{n === 1 ? "" : "s"}
          {kind === "locked" ? (
            <>
              {" "}
              that {n === 1 ? "is" : "are"} locked. Unlock {n === 1 ? "it" : "them"} to edit the
              question.
            </>
          ) : (
            "."
          )}
        </DialogDescription>
        <div className="flex flex-col gap-1.5">
          {scripts.map((script) => (
            <Link
              key={script.scriptId}
              to="/$orgSlug/scripts/$scriptId"
              params={{ orgSlug, scriptId: script.scriptId }}
              className="flex h-8 items-center gap-1.5 rounded-md border border-border pl-2 pr-2.5 text-sm hover:bg-muted"
            >
              <Icon name="clipboard-pen" className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate">{script.name}</span>
              {script.archived ? <span className="text-muted-foreground">(archived)</span> : null}
              <Icon
                name="chevron-right"
                className="ml-auto size-3.5 shrink-0 text-muted-foreground"
              />
            </Link>
          ))}
        </div>
        <div className="mt-5 flex justify-end">
          <DialogClose render={<Button variant="outline" />}>Close</DialogClose>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ArchiveQuestionDialog({
  open,
  onOpenChange,
  questionName,
  usedCount,
  gatesSteps,
  pending,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  questionName: string;
  usedCount: number;
  gatesSteps: boolean;
  pending: boolean;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        {gatesSteps ? (
          <>
            <DialogTitle>Can't archive question</DialogTitle>
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
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

// One Dialog wraps both create and edit phases so the overlay doesn't
// flash on the create → edit handoff.
function QuestionModal({
  initialQuestionId,
  source,
  onClose,
}: {
  initialQuestionId: string | null;
  source: CloneSource | null;
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
        {questionId === null && source ? (
          <CloneBody
            source={source}
            onCloned={(question) => {
              queryClient.setQueryData(["question", question.questionId], question);
              void queryClient.invalidateQueries({ queryKey: ["questions"] });
              onClose();
            }}
          />
        ) : questionId === null ? (
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

function CloneBody({
  source,
  onCloned,
}: {
  source: CloneSource;
  onCloned: (question: Awaited<ReturnType<typeof client.questions.clone>>) => void;
}) {
  const [name, setName] = useState(`${source.name} (copy)`);
  const clone = useMutation({
    mutationFn: (name: string) => client.questions.clone({ questionId: source.questionId, name }),
    onSuccess: onCloned,
    onError: (e) => notify.error(e.message),
  });

  const valid = name.trim().length > 0;

  return (
    <>
      <DialogTitle>Clone question</DialogTitle>
      <DialogDescription>
        This creates a new question with the same type, text, and active responses. It won't be in
        any script, it will be unlocked, and you'll be able to edit it.
      </DialogDescription>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!valid || clone.isPending) return;
          clone.mutate(name.trim());
        }}
        className="flex flex-col gap-4"
      >
        <div className="flex flex-col gap-1.5">
          <label className="text-sm text-muted-foreground">Name</label>
          <Input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={clone.isPending}
          />
        </div>
        <div className="mt-2 flex justify-end gap-2">
          <DialogClose render={<Button variant="outline" type="button" />}>Cancel</DialogClose>
          <Button type="submit" disabled={!valid} loading={clone.isPending}>
            <Icon name="copy" />
            Clone
          </Button>
        </div>
      </form>
    </>
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
          <EditNameInput
            value={question.name}
            onCommit={(name) => rename.mutate(name)}
            disabled={question.lockedBy.length > 0}
          />
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

function EditNameInput({
  value,
  onCommit,
  disabled,
}: {
  value: string;
  onCommit: (text: string) => void;
  disabled: boolean;
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
      disabled={disabled}
    />
  );
}
