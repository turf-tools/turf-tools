import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { magicLink } from "better-auth/plugins";
import { Resend } from "resend";
import { and, db, eq, isNull } from "@field-tools/db";
import { accounts, memberships, sessions, users, verifications } from "@field-tools/db/schema";
import { normalizeEmail } from "./normalize-email";

// Resolved lazily so dev can boot without RESEND_API_KEY; magic links print
// to the server console in that case.
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
      // One-line trace of every auth request — gives us magic-link send +
      // verify visibility (BA's own logger doesn't instrument these).
      // `?` masks the token value, just records whether one was present.
      const hasToken = typeof ctx.query?.token === "string";
      const emailHint =
        typeof ctx.body?.email === "string" ? ctx.body.email.slice(0, 3) + "…" : null;
      console.log(
        `[auth] ${ctx.method ?? "?"} ${ctx.path}` +
          (hasToken ? " token=<present>" : "") +
          (emailHint ? ` email=${emailHint}` : ""),
      );

      // Normalize the typed email to its canonical form before BA's own
      // logic sees it — the verification record and any downstream user
      // lookups all key on `users.email`, which we store canonicalised.
      if (ctx.path === "/sign-in/magic-link" && typeof ctx.body?.email === "string") {
        ctx.body.email = normalizeEmail(ctx.body.email);
      }
    }),
    after: createAuthMiddleware(async (ctx) => {
      // Magic-link verify always 302s — to the callbackURL on success
      // (with a Set-Cookie carrying the session) or to errorCallbackURL
      // with `?error=<reason>` on failure. Logging both lets us tell
      // "token consumed by a scanner" (error=INVALID_TOKEN) from
      // "succeeded but cookie didn't stick" (no error, cookie present
      // in our logs but missing from the user's browser later) from
      // any path we haven't anticipated yet.
      if (ctx.path !== "/magic-link/verify") return;
      const headers = ctx.context.responseHeaders;
      const location = headers?.get("location") ?? null;
      const setCookie = headers?.get("set-cookie") ?? null;
      const cookieSet = !!setCookie && setCookie.includes("session");
      let error: string | null = null;
      if (location) {
        try {
          // `location` may be absolute or path-relative; the base is
          // unused since we only read the query string.
          error = new URL(location, "http://placeholder").searchParams.get("error");
        } catch {
          /* malformed Location header — ignore */
        }
      }
      console.log(
        `[auth] verify result: location=${location ?? "?"} cookie=${cookieSet ? "set" : "missing"}` +
          (error ? ` error=${error}` : ""),
      );
    }),
  },
  plugins: [
    magicLink({
      disableSignUp: true,
      expiresIn: 60 * 60,
      sendMagicLink: async ({ email, url }) => {
        // `email` is already canonical thanks to the before-hook. Membership
        // gate — BA's disableSignUp only fires at verify-time, so without
        // this check the link gets sent first and the user only sees the
        // failure after clicking it. We gate on an *active* (non-archived)
        // membership rather than just users-row existence, so removed/archived
        // people get the same rejection as strangers.
        const row = (
          await db
            .select({ id: users.id, displayEmail: users.displayEmail })
            .from(users)
            .innerJoin(memberships, eq(memberships.userId, users.id))
            .where(and(eq(users.email, email), isNull(memberships.archivedAt)))
            .limit(1)
        )[0];
        if (!row) {
          throw new APIError("BAD_REQUEST", {
            message: "No account found for this email",
          });
        }
        const to = row.displayEmail;
        const resend = getResend();
        if (!resend) {
          console.log(`[auth] magic link for ${to}: ${url}`);
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
    <a href="${url}" style="background-color: #222222; color: white; padding: 12px 20px; text-decoration: none; border-radius: 6px; font-size: 16px; display: inline-block;">
      Log in to Field Tools
    </a>
  </p>

  <p style="font-size: 16px;">If you didn't request this email, you can safely ignore it.</p>

  <p style="font-size: 16px; color: #888;">This link will expire in 1 hour.</p>
</div>`,
        });
      },
    }),
  ],
});
