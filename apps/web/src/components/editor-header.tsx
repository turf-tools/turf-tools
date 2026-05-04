import type { ReactNode } from "react";

export function EditorHeader({
  title,
  subtitle,
  leading,
  children,
}: {
  title: string;
  subtitle?: string | null;
  leading?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="mb-4 flex h-8 items-center justify-between">
      <div className="flex items-center gap-3">
        {leading}
        <div className="flex items-baseline gap-3">
          <h1 className="text-xl font-extrabold tracking-wide italic">{title}</h1>
          {subtitle ? (
            <span className="text-sm text-muted-foreground italic">{subtitle}</span>
          ) : null}
        </div>
      </div>
      {children ? <div className="flex items-center gap-2">{children}</div> : null}
    </div>
  );
}
