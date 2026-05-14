import { useMutation } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { useEffect, useState, type FormEvent } from "react";
import { Button } from "~/components/button";
import { Input } from "~/components/input";
import { LightDarkToggle } from "~/components/light-dark-toggle";
import { LoadingIndicator } from "~/components/loading-indicator";
import { authClient } from "~/lib/auth-client";
import { getSession } from "~/lib/server/session";
import { cn } from "~/lib/utils";

export const Route = createFileRoute("/login")({
  beforeLoad: async () => {
    const session = await getSession();
    if (session) throw redirect({ to: "/" });
  },
  component: LoginPage,
});

type FormState = "idle" | "sending" | "sent";

function LoginPage() {
  const [email, setEmail] = useState("");
  const [state, setState] = useState<FormState>("idle");

  // Cross-tab login signal — see __root's beforeLoad.
  useEffect(() => {
    const channel = new BroadcastChannel("auth");
    channel.onmessage = (e) => {
      if (typeof e.data === "object" && e.data?.type === "logged-in") {
        window.location.replace("/");
      }
    };
    return () => channel.close();
  }, []);

  // Held separately from state so it stays visible across resubmits — it only
  // clears on a successful send.
  const [error, setError] = useState<string | null>(null);

  // Wrapped in useMutation so the global LoadingIndicator picks it up via
  // useIsMutating. Minimum 600ms floor so "Sending…" reads as intentional
  // even when the network is fast.
  const mutation = useMutation({
    mutationFn: async (target: string) => {
      const [res] = await Promise.all([
        authClient.signIn.magicLink({ email: target, callbackURL: "/" }),
        new Promise((r) => setTimeout(r, 600)),
      ]);
      return res;
    },
  });

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setState("sending");
    const res = await mutation.mutateAsync(email);
    if (res.error) {
      // BA's zod errors come prefixed with the field path (e.g. "[body.email] …").
      const raw = res.error.message ?? "Login failed";
      setError(raw.replace(/^\[[^\]]+\]\s*/, ""));
      setState("idle");
      return;
    }
    setError(null);
    setState("sent");
  };

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="fixed top-3 right-4 flex items-center gap-3">
        <LoadingIndicator />
        <LightDarkToggle />
      </div>
      <div className="w-full max-w-sm -mt-16 animate-in fade-in duration-100">
        <h1 className="mb-5 text-center text-5xl italic font-bold tracking-tight">Field Tools</h1>
        <p className="mb-8 text-center text-[16px] text-muted-foreground">
          Enter your email to receive a login link
        </p>
        <form onSubmit={onSubmit} className="flex flex-col gap-3">
          <Input
            type="email"
            placeholder="you@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoFocus
            className="text-[16px]"
          />
          <Button
            type="submit"
            className="h-10 disabled:opacity-100 text-[16px]"
            disabled={state === "sending"}
          >
            {state === "sending" ? "Sending…" : "Send login link"}
          </Button>
        </form>
        <FormMessage state={state} error={error} />
      </div>
    </div>
  );
}

function FormMessage({ state, error }: { state: FormState; error: string | null }) {
  if (state === "sent") {
    return (
      <p
        className={cn(
          "mt-4 rounded-md border border-success/30 bg-success/5 p-3 text-sm text-success",
        )}
      >
        Check your inbox for a login link
      </p>
    );
  }
  if (error) {
    return (
      <p
        className={cn(
          "mt-4 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive",
        )}
      >
        {error}
      </p>
    );
  }
  return null;
}
