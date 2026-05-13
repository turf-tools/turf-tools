import { useRouteContext } from "@tanstack/react-router";
import { LogOut } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./dropdown-menu";
import { authClient } from "~/lib/auth-client";
import { cn } from "~/lib/utils";

export function UserBadge() {
  const ctx = useRouteContext({ from: "__root__" });
  const session = ctx.session ?? null;
  const email = session?.user.email ?? null;
  const initials = email ? email[0]!.toUpperCase() : "?";

  const onSignOut = async () => {
    await authClient.signOut();
    // Notify other tabs so they redirect immediately on cookie loss.
    const channel = new BroadcastChannel("auth");
    channel.postMessage("logged-out");
    channel.close();
    // Full-document nav so the new chrome (or lack of it) renders fresh.
    window.location.replace("/login");
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={cn(
          "flex size-8 items-center justify-center",
          "rounded-full bg-foreground",
          "text-xs font-medium text-background",
          "outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
        )}
        aria-label="Account menu"
      >
        {initials}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        {email ? (
          <>
            <div className="px-2 py-1.5 text-sm text-muted-foreground">{email}</div>
            <DropdownMenuSeparator />
          </>
        ) : null}
        <DropdownMenuItem onClick={onSignOut}>
          <LogOut className="size-3.5" />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
