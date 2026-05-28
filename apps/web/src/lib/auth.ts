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
  // "info" surfaces BA's config-validation + internal errors. Per-request
  // OTP send/verify tracing is in the hooks below — BA itself doesn't log
  // around those.
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
      // Per-request trace; OTP values never logged. `/get-session` fires
      // on every page load and would drown out the signal.
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

      // Membership gate for OTP send — invite-only tool, surface a visible
      // "no account found" instead of the silent no-op BA's emailOTP plugin
      // returns for unknown emails under `disableSignUp: true`. We accept
      // the small existence-leak.
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
      // Verify-outcome trace. Without this, server logs are silent on
      // success vs failure — exactly the visibility we need when
      // diagnosing scanner-burned-token failures.
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
      // Two-channel delivery to defeat email security scanners. The OTP
      // sits in the verify-page URL — link click triggers a client-side
      // POST on mount that GET-based scanners can't fire by pre-fetching
      // the page. The same OTP is also rendered as a human-typeable string
      // in the email body and `/login`'s code-entry step accepts it as a
      // manual fallback for the minority of scanners that execute JS and
      // would otherwise burn the link.
      sendVerificationOTP: async ({ email, otp, type }) => {
        // We only use the sign-in flow; other types (email-verification,
        // forget-password, change-email) aren't wired up.
        if (type !== "sign-in") return;
        // The before-hook has already canonicalised `email` and confirmed
        // an active membership exists. This lookup is just to grab the
        // displayEmail for the outbound `to`.
        const row = (
          await db
            .select({ displayEmail: users.displayEmail })
            .from(users)
            .where(eq(users.email, email))
            .limit(1)
        )[0];
        if (!row) {
          // Unreachable per the before-hook guarantee. Log loudly if it fires.
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
