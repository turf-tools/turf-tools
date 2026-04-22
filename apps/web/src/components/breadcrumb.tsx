import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { client } from "~/rpc/client";

// Static left-side identifier: Field Tools / Org name. Track is no longer
// a session-level scope — it's a filter on list views (see ListFilterBar)
// — so it doesn't belong in the breadcrumb.
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
      {org ? <Segment label={org.name} /> : null}
      {children ? (
        <>
          <Separator />
          {children}
        </>
      ) : null}
    </div>
  );
}

function Segment({ label }: { label: string }) {
  return (
    <>
      <Separator />
      <span className="italic">{label}</span>
    </>
  );
}

function Separator() {
  return <span className="text-muted-foreground/50">/</span>;
}
