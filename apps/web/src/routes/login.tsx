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

// Four-state flow:
//   email   – user types their email and submits
//   sent    – we sent the email; user can wait for the link OR click "Enter
//             code manually" to switch to the code-entry state
//   code    – user pastes the OTP from the email and submits
//   invalid – code didn't verify (typo, expired, already-burned by scanner)
// "Back to login" links + the invalid-state button all reset to `email`.
type Step = "email" | "sent" | "code" | "invalid";

function LoginPage() {
  const [step, setStep] = useState<Step>("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
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

  // 600ms floor on both mutations so button-state transitions read as
  // intentional even on fast networks (matches the prior magic-link flow).
  const sendCode = useMutation({
    mutationFn: async (target: string) => {
      const [res] = await Promise.all([
        authClient.emailOtp.sendVerificationOtp({ email: target, type: "sign-in" }),
        new Promise((r) => setTimeout(r, 600)),
      ]);
      return res;
    },
  });

  const verifyCode = useMutation({
    mutationFn: async (input: { email: string; otp: string }) => {
      const [res] = await Promise.all([
        authClient.signIn.emailOtp(input),
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

  const onSubmitCode = async (e: FormEvent) => {
    e.preventDefault();
    const res = await verifyCode.mutateAsync({ email, otp: code.trim() });
    if (res.error) {
      setStep("invalid");
      return;
    }
    // Hard-load to "/" — root's mount-time effect broadcasts the
    // logged-in signal (with userId). Broadcasting from here would
    // lack a userId and trip the root listener's user-switch reload.
    window.location.replace("/");
  };

  // "Back to login" / "Return to login" — full reset.
  const reset = () => {
    setStep("email");
    setEmail("");
    setCode("");
    setError(null);
  };

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="fixed top-3 right-4 flex items-center gap-3">
        <LoadingIndicator />
        <LightDarkToggle />
      </div>
      <div className="w-full max-w-sm -mt-16 animate-in fade-in duration-100">
        <h1 className="mb-5 text-center text-5xl italic font-bold tracking-tight">Field Tools</h1>
        {step === "email" ? (
          <EmailStep
            email={email}
            setEmail={(next) => {
              setEmail(next);
              // Clear the error as soon as the user starts editing — otherwise
              // a stale "no account found" sits there next to a half-typed
              // new email, which reads like the field still has the problem.
              if (error) setError(null);
            }}
            pending={sendCode.isPending}
            onSubmit={onSubmitEmail}
            error={error}
          />
        ) : step === "sent" ? (
          <SentStep email={email} onEnterCode={() => setStep("code")} onBack={reset} />
        ) : step === "code" ? (
          <CodeStep
            code={code}
            setCode={setCode}
            pending={verifyCode.isPending}
            onSubmit={onSubmitCode}
            onBack={reset}
          />
        ) : (
          <InvalidStep onReturn={reset} />
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
        <p
          className={cn(
            "mt-4 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive",
          )}
        >
          {error}
        </p>
      ) : null}
    </>
  );
}

function SentStep({
  email,
  onEnterCode,
  onBack,
}: {
  email: string;
  onEnterCode: () => void;
  onBack: () => void;
}) {
  return (
    <>
      <p className="mb-8 text-center text-[16px] text-muted-foreground">
        We've sent a temporary login link, please check your inbox at{" "}
        <span className="text-foreground">{email}</span>. If you have trouble with magic links, you
        can also check the email for a code and click below to manually enter it.
      </p>
      <Button
        variant="outline"
        type="button"
        onClick={onEnterCode}
        className="h-10 w-full text-[16px]"
      >
        Enter code manually
      </Button>
      <BackToLogin onClick={onBack} />
    </>
  );
}

function CodeStep({
  code,
  setCode,
  pending,
  onSubmit,
  onBack,
}: {
  code: string;
  setCode: (v: string) => void;
  pending: boolean;
  onSubmit: (e: FormEvent) => void;
  onBack: () => void;
}) {
  return (
    <>
      <p className="mb-8 text-center text-[16px] text-muted-foreground">
        Check your email for a temporary login code and enter it below.
      </p>
      <form onSubmit={onSubmit} className="flex flex-col gap-3">
        <Input
          type="text"
          placeholder="Login code (6 digits)"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          required
          autoFocus
          autoComplete="one-time-code"
          className="text-[16px] tabular-nums"
        />
        <Button type="submit" className="h-10 disabled:opacity-100 text-[16px]" disabled={pending}>
          {pending ? "Signing in…" : "Continue with login code"}
        </Button>
      </form>
      <BackToLogin onClick={onBack} />
    </>
  );
}

function InvalidStep({ onReturn }: { onReturn: () => void }) {
  return (
    <>
      <p className="mb-8 text-center text-[16px] text-muted-foreground">
        This code is no longer valid, please try again.
      </p>
      <Button type="button" onClick={onReturn} className="h-10 w-full text-[16px]">
        Return to login
      </Button>
    </>
  );
}

function BackToLogin({ onClick }: { onClick: () => void }) {
  return (
    <div className="mt-4 text-center">
      <button
        type="button"
        onClick={onClick}
        className="text-sm text-muted-foreground hover:text-foreground"
      >
        Back to login
      </button>
    </div>
  );
}
