import { useMutation } from "@tanstack/react-query";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "~/components/button";
import { Input } from "~/components/input";
import { Page } from "~/components/page";
import { Pill } from "~/components/pill";
import { roleLabel } from "~/lib/permissions";
import { useFadeOnce } from "~/lib/use-fade-once";
import { client } from "~/rpc/client";

export const Route = createFileRoute("/$orgSlug/account")({
  component: AccountPage,
});

function AccountPage() {
  const router = useRouter();
  const { session } = Route.useRouteContext();
  const user = session?.user;
  const shouldFade = useFadeOnce("/account");

  const [name, setName] = useState(user?.name ?? "");
  const trimmed = name.trim();
  const initial = user?.name ?? "";
  const dirty = trimmed !== initial;
  const valid = trimmed.length > 0;

  const updateName = useMutation({
    mutationFn: (next: string) => client.users.updateOwnName({ name: next }),
    onSuccess: () => router.invalidate(),
    onError: (e) => console.error("users.updateOwnName failed", e),
  });

  if (!user) return null;

  return (
    <Page className={shouldFade}>
      <div className="mb-4 flex h-8 items-center justify-between">
        <h1 className="text-xl font-extrabold tracking-wide italic">Account</h1>
      </div>

      <div className="flex max-w-md flex-col gap-4">
        <Field label="Email">
          <Pill>
            <span className="truncate">{user.email}</span>
          </Pill>
        </Field>

        <Field label="Role">
          <Pill>
            <span>{roleLabel(user.role)}</span>
          </Pill>
        </Field>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!valid || !dirty || updateName.isPending) return;
            updateName.mutate(trimmed);
          }}
          className="flex flex-col gap-1.5"
        >
          <label className="text-sm text-muted-foreground">Name</label>
          <div className="flex gap-2">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Your name"
              disabled={updateName.isPending}
            />
            <Button
              type="submit"
              size="lg"
              disabled={!valid || !dirty}
              loading={updateName.isPending}
            >
              Save
            </Button>
          </div>
          {updateName.error ? (
            <p className="text-sm text-destructive">{updateName.error.message}</p>
          ) : null}
        </form>
      </div>
    </Page>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-sm text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}
