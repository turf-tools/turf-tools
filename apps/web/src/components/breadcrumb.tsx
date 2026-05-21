import { useNavigate } from "@tanstack/react-router";
import { Check, ChevronDown } from "lucide-react";
import type { ReactNode } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/components/dropdown-menu";
import type { SessionOrg } from "~/lib/server/session";
import { cn } from "~/lib/utils";

// Static "Field Tools / <org>" identifier; the org name is also an
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
    <div className="flex items-center gap-2 text-sm text-muted-foreground">
      <span className="font-bold text-foreground italic">Field Tools</span>
      <Separator />
      <span className="italic text-foreground">{orgName}</span>
      {isMulti ? <OrgSwitcher currentSlug={orgSlug} orgs={orgs} /> : null}
      {children ? (
        <>
          <Separator />
          {children}
        </>
      ) : null}
    </div>
  );
}

function OrgSwitcher({
  currentSlug,
  orgs,
}: {
  currentSlug: string;
  orgs: ReadonlyArray<SessionOrg>;
}) {
  const navigate = useNavigate();
  const sorted = [...orgs].sort((a, b) => a.orgName.localeCompare(b.orgName));
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label="Switch organization"
        onMouseDown={(e) => e.preventDefault()}
        className={cn(
          "flex h-6 w-6 items-center rounded-md justify-center -ml-1",
          "text-muted-foreground hover:bg-muted hover:text-foreground",
          "outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
        )}
      >
        <ChevronDown className="size-4" />
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
              {isCurrent ? <Check className="ml-auto size-4 shrink-0 text-foreground" /> : null}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function Separator() {
  return <span className="text-muted-foreground/50">/</span>;
}
