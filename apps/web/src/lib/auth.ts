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
      expiresIn: 60 * 60,
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
