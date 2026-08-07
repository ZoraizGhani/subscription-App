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

/**
 * Wraps transactional email content in a shared layout (logo-style header,
 * card body, footer disclaimer). Inline styles only -- email clients strip
 * `<style>` blocks and external stylesheets, so anything not inlined won't
 * render in Outlook/Gmail.
 */
function renderEmailLayout({ shopName, bodyHtml }: { shopName: string; bodyHtml: string }) {
  return `
<div style="background-color:#f4f4f5;padding:40px 16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <div style="max-width:480px;margin:0 auto;">
    <div style="text-align:center;padding-bottom:24px;">
      <span style="font-size:14px;font-weight:600;letter-spacing:0.02em;color:#6b7280;text-transform:uppercase;">${shopName}</span>
    </div>
    <div style="background-color:#ffffff;border-radius:12px;padding:32px;box-shadow:0 1px 3px rgba(0,0,0,0.08);">
      ${bodyHtml}
    </div>
    <div style="text-align:center;padding-top:24px;">
      <span style="font-size:12px;color:#9ca3af;">This email was sent by ${shopName}. If you have questions, contact the store directly.</span>
    </div>
  </div>
</div>`.trim();
}

export function renderPasswordResetEmail({ shopName, resetUrl }: { shopName: string; resetUrl: string }) {
  const bodyHtml = `
    <h1 style="margin:0 0 16px;font-size:20px;color:#111827;">Reset your password</h1>
    <p style="margin:0 0 24px;font-size:15px;line-height:1.5;color:#374151;">
      Someone requested a password reset for your account at ${shopName}. Click the button below to choose a new password.
    </p>
    <div style="text-align:center;margin:0 0 24px;">
      <a href="${resetUrl}" style="display:inline-block;background-color:#111827;color:#ffffff;text-decoration:none;font-size:15px;font-weight:600;padding:12px 28px;border-radius:8px;">
        Reset your password
      </a>
    </div>
    <p style="margin:0;font-size:13px;line-height:1.5;color:#6b7280;">
      This link expires in 1 hour. If you didn't request this, you can safely ignore this email -- your password won't be changed.
    </p>`;
  return renderEmailLayout({ shopName, bodyHtml });
}
