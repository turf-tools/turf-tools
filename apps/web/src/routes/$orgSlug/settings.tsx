import { useMutation } from "@tanstack/react-query";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { ChevronDown } from "lucide-react";
import { Button } from "~/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "~/components/dropdown-menu";
import { Page } from "~/components/page";
import { DEFAULT_DISPLAY_TIMEZONE, type DisplayTimezone, TIMEZONE_OPTIONS } from "~/lib/timezones";
import { useDeferredRadioDropdown } from "~/lib/use-deferred-radio-dropdown";
import { useFadeOnce } from "~/lib/use-fade-once";
import { client } from "~/rpc/client";

export const Route = createFileRoute("/$orgSlug/settings")({
  component: SettingsPage,
});

function SettingsPage() {
  const router = useRouter();
  const { session } = Route.useRouteContext();
  const user = session?.user;
  const shouldFade = useFadeOnce("/settings");

  const updateTimezone = useMutation({
    mutationFn: (tz: DisplayTimezone) =>
      client.users.updateOwnDisplayTimezone({ displayTimezone: tz }),
    onSuccess: () => router.invalidate(),
    onError: (e) => console.error("users.updateOwnDisplayTimezone failed", e),
  });

  const tzDropdown = useDeferredRadioDropdown({
    onCommit: (v) => updateTimezone.mutate(v as DisplayTimezone),
  });

  if (!user) return null;

  const currentTz = (user.displayTimezone as DisplayTimezone | null) ?? DEFAULT_DISPLAY_TIMEZONE;
  const currentTzLabel = TIMEZONE_OPTIONS.find((o) => o.value === currentTz)?.label ?? currentTz;

  return (
    <Page className={shouldFade}>
      <div className="mb-4 flex h-8 items-center justify-between">
        <h1 className="text-xl font-extrabold tracking-wide italic">Settings</h1>
      </div>

      <div className="flex max-w-md flex-col gap-4">
        <Field label="Timezone for display">
          <DropdownMenu {...tzDropdown.menu}>
            <DropdownMenuTrigger
              render={<Button variant="outline" className={"w-full justify-between"} />}
            >
              <span>{currentTzLabel}</span>
              <ChevronDown className="size-3.5" />
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuRadioGroup {...tzDropdown.radio} value={currentTz}>
                {TIMEZONE_OPTIONS.map((o) => (
                  <DropdownMenuRadioItem key={o.value} value={o.value}>
                    {o.label}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
          {updateTimezone.error ? (
            <p className="text-sm text-destructive">{updateTimezone.error.message}</p>
          ) : null}
        </Field>
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
