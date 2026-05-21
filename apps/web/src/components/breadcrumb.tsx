import { useNavigate } from "@tanstack/react-router";
import { ChevronDown } from "lucide-react";
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
  orgName: string;
  orgs: ReadonlyArray<SessionOrg>;
  children?: ReactNode;
};

export function Breadcrumb({ orgName, orgs, children }: BreadcrumbProps) {
  const isMulti = orgs.length > 1;
  return (
    <div className="flex items-center gap-2 text-sm text-muted-foreground">
      <span className="font-bold text-foreground italic">Field Tools</span>
      <Separator />
      <span className="italic text-foreground">{orgName}</span>
      {isMulti ? <OrgSwitcher orgs={orgs} /> : null}
      {children ? (
        <>
          <Separator />
          {children}
        </>
      ) : null}
    </div>
  );
}

function OrgSwitcher({ orgs }: { orgs: ReadonlyArray<SessionOrg> }) {
  const navigate = useNavigate();
  const sorted = [...orgs].sort((a, b) => a.orgName.localeCompare(b.orgName));
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label="Switch organization"
        className={cn(
          "flex h-6 w-6 items-center rounded-md justify-center -ml-1",
          "text-muted-foreground hover:bg-muted hover:text-foreground",
        )}
      >
        <ChevronDown className="size-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" sideOffset={6} className="min-w-44">
        {sorted.map((o) => (
          <DropdownMenuItem
            key={o.orgSlug}
            onClick={() =>
              void navigate({ to: "/$orgSlug/overview", params: { orgSlug: o.orgSlug } })
            }
          >
            {o.orgName}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function Separator() {
  return <span className="text-muted-foreground/50">/</span>;
}
