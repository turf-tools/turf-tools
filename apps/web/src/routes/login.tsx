import { useMutation } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { useEffect, useState, type FormEvent } from "react";
import { Button } from "~/components/button";
import { Callout } from "~/components/callout";
import { Input } from "~/components/input";
import { LightDarkToggle } from "~/components/light-dark-toggle";
import { LoadingIndicator } from "~/components/loading-indicator";
import { authClient } from "~/lib/auth-client";

export const Route = createFileRoute("/login")({
  // Reads the session from root context — never its own getSession call.
  // Both sides of the "/" ↔ "/login" redirect pair must consult the same
  // value, or a login race can bounce a tab between them forever.
  beforeLoad: ({ context }) => {
    if (context.session) throw redirect({ to: "/" });
  },
  component: LoginPage,
});

// Two-state flow:
//   email – user types their email and submits
//   sent  – we sent the login link; user clicks through from their inbox.
// Verification happens entirely on the verify page (the email link); there's
// no manual code-entry path — the link is the only channel.
type Step = "email" | "sent";

function LoginPage() {
  const [step, setStep] = useState<Step>("email");
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);

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

  // 600ms floor so the button-state transition reads as intentional even on
  // fast networks.
  const sendCode = useMutation({
    mutationFn: async (target: string) => {
      const [res] = await Promise.all([
        authClient.emailOtp.sendVerificationOtp({ email: target, type: "sign-in" }),
        new Promise((r) => setTimeout(r, 600)),
      ]);
      return res;
    },
  });

  const onSubmitEmail = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const res = await sendCode.mutateAsync(email);
    if (res.error) {
      // BA's zod errors come prefixed with the field path (e.g. "[body.email] …").
      setError((res.error.message ?? "Login failed").replace(/^\[[^\]]+\]\s*/, ""));
      return;
    }
    setStep("sent");
  };

  // "Back to login" — full reset.
  const reset = () => {
    setStep("email");
    setEmail("");
    setError(null);
  };

  // dvh, not vh: mobile 100vh assumes collapsed browser chrome, so the page
  // overflows (and scrolls) while the URL bar is showing.
  return (
    <div className="flex min-h-dvh items-center justify-center px-4">
      <div className="fixed top-3 right-4 flex items-center gap-3">
        <LoadingIndicator />
        <LightDarkToggle />
      </div>
      <div className="w-full max-w-sm -mt-16 animate-in fade-in duration-100">
        <h1 className="mb-5 text-center text-5xl italic font-bold tracking-tight">Turf Tools</h1>
        {step === "email" ? (
          <EmailStep
            email={email}
            setEmail={(next) => {
              setEmail(next);
              // Clear any stale error as the user starts editing — otherwise
              // it sits next to a half-typed new email, looking like the
              // field still has the problem.
              if (error) setError(null);
            }}
            pending={sendCode.isPending}
            onSubmit={onSubmitEmail}
            error={error}
          />
        ) : (
          <SentStep email={email} onBack={reset} />
        )}
      </div>
    </div>
  );
}

function EmailStep({
  email,
  setEmail,
  pending,
  onSubmit,
  error,
}: {
  email: string;
  setEmail: (v: string) => void;
  pending: boolean;
  onSubmit: (e: FormEvent) => void;
  error: string | null;
}) {
  return (
    <>
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
        <Button type="submit" className="h-10 disabled:opacity-100 text-[16px]" disabled={pending}>
          {pending ? "Sending…" : "Send login link"}
        </Button>
      </form>
      {error ? (
        <Callout tone="error" className="mt-4">
          {error}
        </Callout>
      ) : null}
    </>
  );
}

function SentStep({ email, onBack }: { email: string; onBack: () => void }) {
  return (
    <>
      <p className="mb-14 text-center text-[16px] text-muted-foreground">
        We've sent a temporary login link, please check your inbox at{" "}
        <span className="text-foreground">{email}</span>.
      </p>
      <Button variant="outline" type="button" onClick={onBack} className="h-10 w-full text-[16px]">
        Back to login
      </Button>
    </>
  );
}
