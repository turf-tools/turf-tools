import { Icon } from "~/components/icon";
import { useNavigate } from "@tanstack/react-router";
import type { ReactNode } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/components/dropdown-menu";
import type { SessionOrg } from "~/lib/server/session";
import { cn } from "~/lib/utils";

// Static "Turf Tools / <org>" identifier; the org name is also an
// org-switcher trigger when the user has memberships in multiple orgs.
// Single-membership users just see the name as plain text.
type BreadcrumbProps = {
  orgSlug: string;
  orgName: string;
  orgs: ReadonlyArray<SessionOrg>;
  children?: ReactNode;
};

export function Breadcrumb({ orgSlug, orgName, orgs, children }: BreadcrumbProps) {
  const isMulti = orgs.length > 1;
  return (
    <div className="flex min-w-0 items-center gap-2 text-sm text-muted-foreground">
      {/* The wordmark is redundant inside the app on a phone — the org
          is the identity that matters; truncate it so the switcher and
          right-side chrome never get pushed out. */}
      <span className="hidden font-bold text-foreground italic md:inline">Turf Tools</span>
      <Separator className="hidden md:inline" />
      {isMulti ? (
        <OrgSwitcher currentSlug={orgSlug} orgName={orgName} orgs={orgs} />
      ) : (
        <OrgName orgName={orgName} />
      )}
      {children ? (
        <>
          <Separator />
          {children}
        </>
      ) : null}
    </div>
  );
}

// `pr-px` gives the last italic glyph's overhang room before truncate's
// overflow-hidden clips it.
function OrgName({ orgName }: { orgName: string }) {
  return (
    <span className="max-w-[45vw] truncate pr-px italic text-foreground md:max-w-none">
      {orgName}
    </span>
  );
}

function OrgSwitcher({
  currentSlug,
  orgName,
  orgs,
}: {
  currentSlug: string;
  orgName: string;
  orgs: ReadonlyArray<SessionOrg>;
}) {
  const navigate = useNavigate();
  const sorted = [...orgs].sort((a, b) => a.orgName.localeCompare(b.orgName));
  return (
    <DropdownMenu>
      {/* The whole name + caret is the trigger; `-ml-1 px-1` keeps the text
          where the plain span sits while the hover pill gets breathing room. */}
      <DropdownMenuTrigger
        aria-label="Switch organization"
        onMouseDown={(e) => e.preventDefault()}
        className={cn(
          "flex h-6 min-w-0 items-center gap-1 rounded-md -ml-1 px-1",
          "text-muted-foreground hover:bg-muted hover:text-foreground",
          "outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
        )}
      >
        <OrgName orgName={orgName} />
        <Icon name="chevron-down" className="size-4 shrink-0" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" sideOffset={6} className="w-max max-w-72">
        {sorted.map((o) => {
          const isCurrent = o.orgSlug === currentSlug;
          return (
            <DropdownMenuItem
              key={o.orgSlug}
              onClick={() =>
                void navigate({ to: "/$orgSlug/overview", params: { orgSlug: o.orgSlug } })
              }
            >
              <span className="min-w-0 truncate">{o.orgName}</span>
              {isCurrent ? (
                <Icon name="check" className="ml-auto size-4 shrink-0 text-foreground" />
              ) : null}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function Separator({ className }: { className?: string }) {
  return <span className={cn("text-muted-foreground/50", className)}>/</span>;
}
