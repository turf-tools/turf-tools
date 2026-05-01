import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { client } from "~/rpc/client";

// Static left-side identifier: Field Tools / Org name. Campaign is not a
// session-level scope — it's a page-level filter (see Filter) — so it
// doesn't belong in the breadcrumb.
type BreadcrumbProps = {
  children?: ReactNode;
};

export function Breadcrumb({ children }: BreadcrumbProps) {
  const { data: org } = useQuery({
    queryKey: ["organization", "current"],
    queryFn: () => client.organizations.getCurrent(),
    placeholderData: keepPreviousData,
  });

  return (
    <div className="flex items-center gap-2 text-sm text-muted-foreground">
      <span className="font-bold text-foreground italic">Field Tools</span>
      {/* Fades in when the org query resolves; only fires on mount. */}
      {org ? (
        <div className="flex items-center gap-2 animate-in fade-in duration-100">
          <Separator />
          <span className="italic">{org.name}</span>
        </div>
      ) : null}
      {children ? (
        <>
          <Separator />
          {children}
        </>
      ) : null}
    </div>
  );
}

function Separator() {
  return <span className="text-muted-foreground/50">/</span>;
}
