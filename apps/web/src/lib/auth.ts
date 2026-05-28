import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware, isAPIError } from "better-auth/api";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { emailOTP } from "better-auth/plugins";
import { Resend } from "resend";
import { and, db, eq, isNull } from "@field-tools/db";
import { accounts, memberships, sessions, users, verifications } from "@field-tools/db/schema";
import { normalizeEmail } from "./normalize-email";

// Resolved lazily so dev can boot without RESEND_API_KEY; the login URL +
// OTP code print to the server console in that case.
let resendClient: Resend | null = null;
function getResend(): Resend | null {
  if (!process.env.RESEND_API_KEY) return null;
  resendClient ??= new Resend(process.env.RESEND_API_KEY);
  return resendClient;
}

export const auth = betterAuth({
  // Default logger level is "warn"; "info" surfaces config-validation
  // warnings + internal errors. BA itself doesn't log around magic-link
  // operations, so for per-request auth tracing we instrument in `hooks`
  // below rather than relying on this.
  logger: { level: "info" },
  database: drizzleAdapter(db, {
    provider: "pg",
    schema: {
      user: users,
      session: sessions,
      account: accounts,
      verification: verifications,
    },
  }),
  advanced: {
    database: {
      generateId: () => crypto.randomUUID(),
    },
  },
  databaseHooks: {
    session: {
      create: {
        // Bump users.lastLoginAt on each successful sign-in. Best-effort —
        // a failed UPDATE here shouldn't fail the sign-in itself.
        after: async (session) => {
          await db
            .update(users)
            .set({ lastLoginAt: new Date() })
            .where(eq(users.id, session.userId))
            .catch((err) => console.error("[auth] lastLoginAt update failed", err));
        },
      },
    },
  },
  hooks: {
    before: createAuthMiddleware(async (ctx) => {
      // One-line trace of every auth request — gives us OTP send + verify
      // visibility. BA's own logger doesn't instrument these. The OTP
      // value itself is never logged. `/get-session` is excluded because
      // it fires on every page load and would drown out the signal.
      if (ctx.path !== "/get-session") {
        const emailHint =
          typeof ctx.body?.email === "string" ? ctx.body.email.slice(0, 3) + "…" : null;
        console.log(
          `[auth] ${ctx.method ?? "?"} ${ctx.path}` + (emailHint ? ` email=${emailHint}` : ""),
        );
      }

      // Normalize the typed email to its canonical form before BA's own
      // logic sees it — verification records and user lookups all key on
      // `users.email`, which we store canonicalised.
      if (
        (ctx.path === "/email-otp/send-verification-otp" || ctx.path === "/sign-in/email-otp") &&
        typeof ctx.body?.email === "string"
      ) {
        ctx.body.email = normalizeEmail(ctx.body.email);
      }

      // Membership gate for OTP send. BA's emailOTP plugin silently
      // no-ops for unknown emails when `disableSignUp: true` (avoids
      // leaking user existence — see /email-otp/send-verification-otp
      // route source). That's the right default for a public SaaS, but
      // for an invite-only internal tool it's worse UX than a visible
      // error: the user types the wrong address, sees "we sent it",
      // waits forever. We gate here in the before-hook so the failure
      // is a visible 4xx instead of a silent success, accepting the
      // small existence-leak.
      if (ctx.path === "/email-otp/send-verification-otp" && typeof ctx.body?.email === "string") {
        const row = (
          await db
            .select({ id: users.id })
            .from(users)
            .innerJoin(memberships, eq(memberships.userId, users.id))
            .where(and(eq(users.email, ctx.body.email), isNull(memberships.archivedAt)))
            .limit(1)
        )[0];
        if (!row) {
          throw new APIError("BAD_REQUEST", {
            message: "No account found for this email",
          });
        }
      }
    }),
    after: createAuthMiddleware(async (ctx) => {
      // Verify-outcome trace for `/sign-in/email-otp`. The client knows
      // the outcome (it's how /login decides whether to flip to the
      // invalid-code state), but server logs would otherwise be silent
      // — which is exactly the visibility we want when debugging
      // scanner-burned-token failures on pilot. The OTP value is never
      // logged.
      if (ctx.path !== "/sign-in/email-otp") return;
      const returned = ctx.context.returned;
      const headers = ctx.context.responseHeaders;
      const cookieSet = !!headers?.get("set-cookie")?.includes("session");
      if (isAPIError(returned)) {
        const status = returned.status ?? "?";
        const message = returned.body?.message ?? "(no message)";
        console.log(`[auth] verify failed: status=${status} message=${message}`);
        return;
      }
      console.log(`[auth] verify ok: cookie=${cookieSet ? "set" : "missing"}`);
    }),
  },
  plugins: [
    emailOTP({
      disableSignUp: true,
      expiresIn: 60 * 60,
      // The OTP is embedded in the verify-page URL (`/auth/email/:email/:code`)
      // and never displayed to the user in Phase 1 — the email contains
      // only the clickable link. The verify page POSTs the code to BA
      // from a client-side effect on mount, so GET-based email scanners
      // (the dominant kind) pre-fetch the URL but never trigger the POST
      // and never burn the code. Phase 2 will also surface the code as a
      // human-typeable string in the email body + a code input on /login
      // for the small minority of scanners that execute JS.
      sendVerificationOTP: async ({ email, otp, type }) => {
        // We only use the sign-in flow; other types (email-verification,
        // forget-password, change-email) aren't wired up.
        if (type !== "sign-in") return;
        // `email` is canonical thanks to the before-hook, and the
        // before-hook has already gated on active membership — so this
        // user definitely exists. We just need their displayEmail for
        // the `to` field on the outbound message.
        const row = (
          await db
            .select({ displayEmail: users.displayEmail })
            .from(users)
            .where(eq(users.email, email))
            .limit(1)
        )[0];
        if (!row) {
          // Shouldn't be reachable — the before-hook guarantees a user
          // row exists for this email. Log loudly if it ever fires.
          console.error(`[auth] sendVerificationOTP: no user row for ${email}`);
          return;
        }
        const to = row.displayEmail;
        const baseUrl = process.env.BETTER_AUTH_URL ?? "http://localhost:3000";
        const verifyUrl = `${baseUrl}/auth/email/${encodeURIComponent(email)}/${otp}`;
        const resend = getResend();
        if (!resend) {
          console.log(`[auth] otp for ${to}: ${otp} (${verifyUrl})`);
          return;
        }
        const from = process.env.RESEND_FROM ?? "Field Tools <onboarding@resend.dev>";
        await resend.emails.send({
          from,
          to,
          subject: "Log in to Field Tools",
          html: `<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; color: #333;">
  <br/>
  <h2 style="font-weight: 600;">Welcome to <i>Field Tools</i></h2>
  <p style="font-size: 16px;">Click the button below to log in securely:</p>

  <p style="text-align: left; margin: 30px 0;">
    <a href="${verifyUrl}" style="background-color: #222222; color: white; padding: 12px 20px; text-decoration: none; border-radius: 6px; font-size: 16px; display: inline-block;">
      Log in to Field Tools
    </a>
  </p>

  <p style="font-size: 16px;">If you have trouble with magic links, you can also enter this code on the login page:</p>

  <p><span style="font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 18px; color: #333; background-color: #f3f3f3; padding: 4px 8px; border-radius: 4px; display: inline-block;">${otp}</span></p>

  <p style="font-size: 16px;">If you didn't request this email, you can safely ignore it.</p>

  <p style="font-size: 16px; color: #888;">This link will expire in 1 hour.</p>
</div>`,
        });
      },
    }),
  ],
});
