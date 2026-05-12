import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { magicLink } from "better-auth/plugins";
import { Resend } from "resend";
import { db, eq } from "@field-tools/db";
import { accounts, sessions, users, verifications } from "@field-tools/db/schema";

// Resolved lazily so dev can boot without RESEND_API_KEY; magic links print
// to the server console in that case.
let resendClient: Resend | null = null;
function getResend(): Resend | null {
  if (!process.env.RESEND_API_KEY) return null;
  resendClient ??= new Resend(process.env.RESEND_API_KEY);
  return resendClient;
}

export const auth = betterAuth({
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
  plugins: [
    magicLink({
      disableSignUp: true,
      sendMagicLink: async ({ email, url }) => {
        // Membership gate — BA's disableSignUp only fires at verify-time, so
        // without this check the link gets sent first and the user only sees
        // the failure after clicking it. Loud rejection up front instead.
        const userRow = (
          await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1)
        )[0];
        if (!userRow) {
          throw new APIError("BAD_REQUEST", {
            message: "No account found for this email",
          });
        }
        const resend = getResend();
        if (!resend) {
          console.log(`[auth] magic link for ${email}: ${url}`);
          return;
        }
        const from = process.env.RESEND_FROM ?? "Field Tools <onboarding@resend.dev>";
        await resend.emails.send({
          from,
          to: email,
          subject: "Log in to Field Tools",
          html: `<p>Click to log in: <a href="${url}">${url}</a></p>`,
        });
      },
    }),
  ],
});
