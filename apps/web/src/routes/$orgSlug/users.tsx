import { Icon } from "~/components/icon";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { notify } from "~/lib/notify";
import { Button } from "~/components/button";
import { DialogError } from "~/components/callout";
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
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "~/components/dropdown-menu";
import { EditorHeader } from "~/components/editor-header";
import { Filter } from "~/components/filter";
import { Input } from "~/components/input";
import { Page } from "~/components/page";
import { Pill } from "~/components/pill";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "~/components/table";
import { Toggle } from "~/components/toggle";
import { formatDate } from "~/lib/format";
import { normalizeEmail } from "~/lib/normalize-email";
import { hasPermission, ROLE_LABELS, roleLabel, ROLES, type Role } from "~/lib/permissions";
import { DEFAULT_DISPLAY_TIMEZONE } from "~/lib/timezones";
import { usersListQuery } from "~/lib/queries/users";
import { useDeferredRadioDropdown } from "~/lib/use-deferred-radio-dropdown";
import { useDelayedFlag } from "~/lib/use-delayed-flag";
import { useDialogMutation } from "~/lib/use-dialog-mutation";
import { useFadeOnce } from "~/lib/use-fade-once";
import { cn } from "~/lib/utils";
import { client } from "~/rpc/client";

type UsersSearch = {
  role: string | null;
  status: string | null;
};

// Default (null) hides archived rows.
const STATUS_OPTIONS = [
  { value: "archived", label: "Archived" },
  { value: "all", label: "All statuses" },
];

const ROLE_OPTIONS = ROLES.map((r) => ({ value: r, label: ROLE_LABELS[r] }));

export const Route = createFileRoute("/$orgSlug/users")({
  validateSearch: (search): UsersSearch => ({
    role: typeof search.role === "string" ? search.role : null,
    status: typeof search.status === "string" ? search.status : null,
  }),
  beforeLoad: ({ context, params }) => {
    if (!hasPermission(context.role, "users.manage")) {
      throw redirect({ to: "/$orgSlug/overview", params: { orgSlug: params.orgSlug } });
    }
  },
  loader: ({ context: { queryClient } }) => queryClient.fetchQuery(usersListQuery()),
  component: UsersIndex,
});

function UsersIndex() {
  const { role: roleFilter, status: statusFilter } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const shouldFade = useFadeOnce("/users");
  const [inviteOpen, setInviteOpen] = useState(false);

  const onRoleChange = (next: string | null) =>
    void navigate({ search: (prev) => ({ ...prev, role: next }) });
  const onStatusChange = (next: string | null) =>
    void navigate({ search: (prev) => ({ ...prev, status: next }) });

  const roleFilterLabel =
    roleFilter === null
      ? "All roles"
      : (ROLE_OPTIONS.find((o) => o.value === roleFilter)?.label ?? null);
  const statusLabel =
    statusFilter === null
      ? "All current"
      : (STATUS_OPTIONS.find((o) => o.value === statusFilter)?.label ?? null);

  return (
    <Page className={cn("flex h-[calc(100vh-3.5rem)] flex-col", shouldFade)}>
      <EditorHeader title="Users">
        <Filter
          icon={<Icon name="tag" className="size-3.5" />}
          label={roleFilterLabel}
          value={roleFilter}
          options={ROLE_OPTIONS}
          allLabel="All roles"
          onChange={onRoleChange}
        />
        <Filter
          icon={<Icon name="activity" className="size-3.5" />}
          label={statusLabel}
          value={statusFilter}
          options={STATUS_OPTIONS}
          allLabel="All current"
          onChange={onStatusChange}
        />
        <Button onClick={() => setInviteOpen(true)}>
          <Icon name="user-round-plus" />
          Invite user
        </Button>
      </EditorHeader>
      <UsersTable roleFilter={roleFilter} statusFilter={statusFilter} />
      <InviteDialog open={inviteOpen} onOpenChange={setInviteOpen} />
    </Page>
  );
}

function UsersTable({
  roleFilter,
  statusFilter,
}: {
  roleFilter: string | null;
  statusFilter: string | null;
}) {
  const { data } = useSuspenseQuery(usersListQuery());
  const rows = data.filter((r) => {
    if (roleFilter && r.role !== roleFilter) return false;
    if (statusFilter === null && r.status === "archived") return false;
    if (statusFilter === "archived" && r.status !== "archived") return false;
    return true;
  });

  return (
    <Table containerClassName="min-h-0 flex-1 overflow-y-auto" className="table-fixed">
      <TableHeader className="[&_th]:sticky [&_th]:top-0 [&_th]:z-10 [&_th]:bg-background">
        <TableRow>
          <TableHead>Name</TableHead>
          <TableHead>Email</TableHead>
          <TableHead className="w-36">Role</TableHead>
          <TableHead className="w-28">Status</TableHead>
          <TableHead className="w-28">Joined</TableHead>
          <TableHead className="w-28">Last login</TableHead>
          <TableHead className="w-11" />
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.length === 0 ? (
          <TableRow className="h-10">
            <TableCell colSpan={7}>
              <Pill>
                <span>No results</span>
              </Pill>
            </TableCell>
          </TableRow>
        ) : null}
        {rows.map((u) => (
          <UserRow key={u.userId} user={u} />
        ))}
      </TableBody>
    </Table>
  );
}

type UserRowData = Awaited<ReturnType<typeof client.users.list>>[number];

function UserRow({ user }: { user: UserRowData }) {
  const queryClient = useQueryClient();
  const { session } = Route.useRouteContext();
  const isSelf = user.userId === session?.user.id;
  const tz = session?.user.displayTimezone ?? DEFAULT_DISPLAY_TIMEZONE;

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["users"] });

  const changeRole = useMutation({
    mutationFn: (role: Role) => client.users.updateRole({ userId: user.userId, role }),
    onSuccess: invalidate,
    onError: (e) => notify.error(e.message),
  });
  const resendInvite = useMutation({
    mutationFn: () => client.users.resendInvite({ userId: user.userId }),
    onSuccess: () => notify.success("Invite sent"),
    onError: (e) => notify.error(e.message),
  });
  const unarchive = useMutation({
    mutationFn: () => client.users.unarchive({ userId: user.userId }),
    onSuccess: invalidate,
    onError: (e) => notify.error(e.message),
  });

  const archive = useDialogMutation({
    mutationFn: () => client.users.archive({ userId: user.userId }),
    onSuccess: invalidate,
  });

  return (
    <>
      <TableRow className={cn(user.status === "archived" && "text-muted-foreground")}>
        <TableCell>
          <Pill className="min-w-0">
            <span className="truncate">{user.name}</span>
          </Pill>
        </TableCell>
        <TableCell>
          <Pill className="min-w-0">
            <span className="truncate">{user.email}</span>
          </Pill>
        </TableCell>
        <TableCell>
          <RoleCell
            role={user.role}
            archived={user.status === "archived"}
            onChange={(role) => changeRole.mutate(role)}
          />
        </TableCell>
        <TableCell>
          <Pill className="capitalize">{user.status}</Pill>
        </TableCell>
        <TableCell>
          <Pill variant="number">{formatDate(user.joinedAt, tz)}</Pill>
        </TableCell>
        <TableCell>
          <Pill variant="number">{formatDate(user.lastLogin, tz)}</Pill>
        </TableCell>
        <TableCell>
          <RowMenu
            user={user}
            isSelf={isSelf}
            onResendInvite={() => resendInvite.mutate()}
            onArchive={archive.open}
            onUnarchive={() => unarchive.mutate()}
          />
        </TableCell>
      </TableRow>
      <ArchiveDialog
        open={archive.isOpen}
        onOpenChange={archive.onOpenChange}
        userLabel={user.name}
        pending={archive.isPending}
        error={archive.error}
        onConfirm={() => archive.mutate(undefined as void)}
      />
    </>
  );
}

function RowMenu({
  user,
  isSelf,
  onResendInvite,
  onArchive,
  onUnarchive,
}: {
  user: UserRowData;
  isSelf: boolean;
  onResendInvite: () => void;
  onArchive: () => void;
  onUnarchive: () => void;
}) {
  // Disabled button keeps row alignment consistent when no actions apply.
  const hasItems = user.status !== "active" || !isSelf;
  if (!hasItems) {
    return (
      <Button variant="outline" size="icon" className="h-8 w-full" disabled>
        <Icon name="more-horizontal" />
      </Button>
    );
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="outline" size="icon" className="h-8 w-full" />}>
        <Icon name="more-horizontal" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        {user.status === "archived" ? (
          <DropdownMenuItem onClick={onUnarchive}>
            <Icon name="archive-restore" />
            Unarchive
          </DropdownMenuItem>
        ) : (
          <>
            {user.status === "pending" ? (
              <DropdownMenuItem onClick={onResendInvite}>
                <Icon name="mail" />
                Send invite
              </DropdownMenuItem>
            ) : null}
            {isSelf ? null : (
              <DropdownMenuItem variant="destructive" onClick={onArchive}>
                <Icon name="archive" />
                Archive
              </DropdownMenuItem>
            )}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function RoleCell({
  role,
  archived,
  onChange,
}: {
  role: string;
  archived: boolean;
  onChange: (role: Role) => void;
}) {
  const dd = useDeferredRadioDropdown({ onCommit: (v) => onChange(v as Role) });
  if (archived) {
    return <Pill>{roleLabel(role)}</Pill>;
  }
  return (
    <DropdownMenu {...dd.menu}>
      <DropdownMenuTrigger render={<Button variant="outline" className="w-full justify-between" />}>
        <span>{roleLabel(role)}</span>
        <Icon name="chevron-down" className="size-3.5" />
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuRadioGroup {...dd.radio} value={role}>
          {ROLES.map((r) => (
            <DropdownMenuRadioItem key={r} value={r}>
              {ROLE_LABELS[r]}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ArchiveDialog({
  open,
  onOpenChange,
  userLabel,
  pending,
  error,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  userLabel: string;
  pending: boolean;
  error: string | null;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogTitle>Archive user?</DialogTitle>
        <DialogDescription>
          Revokes access for <span className="font-medium text-foreground">{userLabel}</span>. You
          can restore them later from the Archived filter.
        </DialogDescription>
        <DialogError error={error} />
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

type InviteRow = { email: string; name: string; role: Role; sendEmail: boolean };

function emptyRow(): InviteRow {
  return { email: "", name: "", role: "admin", sendEmail: false };
}

function InviteDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const { data: existingUsers } = useSuspenseQuery(usersListQuery());
  const [rows, setRows] = useState<InviteRow[]>([emptyRow()]);
  const [error, setError] = useState<string | null>(null);
  const inviteMutation = useMutation({
    mutationFn: async (toInvite: InviteRow[]) => {
      for (const r of toInvite) {
        await client.users.invite({
          email: r.email.trim(),
          name: r.name.trim() || undefined,
          role: r.role,
          sendEmail: r.sendEmail,
        });
      }
    },
    // Errors render inline in the dialog; skip the global error status.
    meta: { errorHandled: true },
    onSuccess: (_data, toInvite) => {
      onOpenChange(false);
      void queryClient.invalidateQueries({ queryKey: ["users"] });
      const emailed = toInvite.filter((r) => r.sendEmail).length;
      notify.success(
        emailed > 0
          ? `Sent ${emailed} invite${emailed === 1 ? "" : "s"}`
          : `Added ${toInvite.length} user${toInvite.length === 1 ? "" : "s"}`,
      );
    },
  });
  // isSuccess keeps the spinner up while the dialog animates closed —
  // isPending alone flashes the idle state first.
  const pending = inviteMutation.isPending || inviteMutation.isSuccess;
  // Delayed copy of `pending` so fast invites don't flash `disabled:opacity-50`
  // on the row Buttons/Toggles (Inputs have no disabled visual). `pending`
  // itself stays synchronous for the submit-double-click guard.
  const pendingDelayed = useDelayedFlag(pending);

  useEffect(() => {
    if (open) {
      setRows([emptyRow()]);
      setError(null);
      inviteMutation.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const valid =
    rows.length > 0 && rows.every((r) => r.email.trim().length > 0 && r.email.includes("@"));

  const submit = () => {
    setError(null);
    // Block partial-success — preflight before inserting. Compare on
    // canonical form so `foo.bar@gmail.com` and `foobar@gmail.com` collide
    // (same mailbox); server enforces the same.
    const inputEmails = rows.map((r) => (r.email.trim() ? normalizeEmail(r.email) : ""));
    // (1) duplicates within the dialog rows themselves
    const seen = new Set<string>();
    const dupes: string[] = [];
    for (const e of inputEmails) {
      if (e.length === 0) continue;
      if (seen.has(e)) dupes.push(e);
      seen.add(e);
    }
    if (dupes.length > 0) {
      setError(`Duplicate email: ${[...new Set(dupes)].join(", ")}`);
      return;
    }
    // (2) emails already on a membership (any status). Archived users
    // must be restored via the row menu, not re-invited.
    const memberEmails = new Set(existingUsers.map((u) => normalizeEmail(u.email)));
    const conflicts = inputEmails.filter((e) => e.length > 0 && memberEmails.has(e));
    if (conflicts.length > 0) {
      setError(`Already a member: ${conflicts.join(", ")}`);
      return;
    }
    inviteMutation.mutate(rows);
  };

  const clearErrors = () => {
    setError(null);
    inviteMutation.reset();
  };
  const updateRow = (i: number, patch: Partial<InviteRow>) => {
    setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
    clearErrors();
  };
  const removeRow = (i: number) => {
    setRows((prev) => prev.filter((_, idx) => idx !== i));
    clearErrors();
  };
  const addRow = () => {
    setRows((prev) => [...prev, emptyRow()]);
    clearErrors();
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Block close-while-pending so click-outside doesn't strand the
        // user wondering whether the invites landed.
        if (pending) return;
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-w-3xl">
        <DialogTitle>Invite users</DialogTitle>
        <DialogDescription>
          Provide an email and name and select a role for each user. Toggle "Email" to automatically
          send an email link (you can also send one later).
        </DialogDescription>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!valid || pending) return;
            submit();
          }}
          className="flex flex-col gap-3"
        >
          <div className="flex flex-col gap-2">
            {rows.map((row, i) => (
              <div key={i} className="flex items-center gap-2">
                <Input
                  type="email"
                  placeholder="email@example.com"
                  value={row.email}
                  onChange={(e) => updateRow(i, { email: e.target.value })}
                  disabled={pendingDelayed}
                  autoFocus={i === rows.length - 1}
                  className="flex-5"
                />
                <Input
                  placeholder="Name (optional)"
                  value={row.name}
                  onChange={(e) => updateRow(i, { name: e.target.value })}
                  disabled={pendingDelayed}
                  className="flex-4"
                />
                <RoleSelect
                  value={row.role}
                  onChange={(role) => updateRow(i, { role })}
                  disabled={pendingDelayed}
                />
                <Toggle
                  variant="outline"
                  size="lg"
                  pressed={row.sendEmail}
                  onPressedChange={(pressed) => updateRow(i, { sendEmail: pressed })}
                  disabled={pendingDelayed}
                  aria-label="Send email invite"
                  className="text-muted-foreground aria-pressed:text-foreground aria-pressed:border-muted-foreground w-21 justify-between"
                >
                  <Icon name="mail" />
                  Email
                </Toggle>
                <Button
                  type="button"
                  variant="outline"
                  size="icon-lg"
                  onClick={() => removeRow(i)}
                  disabled={pendingDelayed || rows.length === 1}
                  aria-label="Remove row"
                >
                  <Icon name="x" />
                </Button>
              </div>
            ))}
          </div>
          <Button
            type="button"
            variant="outline"
            onClick={addRow}
            disabled={pendingDelayed}
            className="self-start"
          >
            <Icon name="plus" />
            Add another
          </Button>
          <DialogError error={error ?? inviteMutation.error?.message ?? null} />
          <div className="mt-2 flex justify-end gap-2">
            <DialogClose render={<Button variant="outline" type="button" />}>Cancel</DialogClose>
            <Button type="submit" disabled={!valid} loading={pending}>
              {rows.some((r) => r.sendEmail) ? "Send invites" : "Add users"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function RoleSelect({
  value,
  onChange,
  disabled,
}: {
  value: Role;
  onChange: (role: Role) => void;
  disabled?: boolean;
}) {
  const dd = useDeferredRadioDropdown({ onCommit: (v) => onChange(v as Role) });
  return (
    <DropdownMenu {...dd.menu}>
      <DropdownMenuTrigger
        disabled={disabled}
        render={
          <Button variant="outline" size="lg" type="button" className="w-36 justify-between" />
        }
      >
        <span>{roleLabel(value)}</span>
        <Icon name="chevron-down" className="size-3.5" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuRadioGroup {...dd.radio} value={value}>
          {ROLES.map((r) => (
            <DropdownMenuRadioItem key={r} value={r}>
              {ROLE_LABELS[r]}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
