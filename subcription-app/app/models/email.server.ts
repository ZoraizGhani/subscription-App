import { Resend } from "resend";

/**
 * Wraps Resend so the rest of the app never touches the client directly.
 * With no RESEND_API_KEY configured (e.g. local dev before creds exist),
 * logs the email to the console instead of throwing -- this is the only way
 * to exercise email-driven flows like password reset before real credentials
 * are wired up.
 */
export async function sendEmail({
  to,
  subject,
  html,
}: {
  to: string;
  subject: string;
  html: string;
}) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM_EMAIL || "onboarding@resend.dev";

  if (!apiKey) {
    console.log(`[email:dev] No RESEND_API_KEY set -- logging instead of sending.\nTo: ${to}\nSubject: ${subject}\n${html}`);
    return;
  }

  const resend = new Resend(apiKey);
  const { error } = await resend.emails.send({ from, to, subject, html });
  if (error) {
    throw new Error(`Failed to send email: ${error.message}`);
  }
}
