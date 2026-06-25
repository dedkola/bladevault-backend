import type { Env } from "./env";

interface EmailPayload {
  to: string;
  subject: string;
  html: string;
  text: string;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export async function sendTransactionalEmail(env: Pick<Env, "RESEND_API_KEY" | "RESEND_FROM_EMAIL">, payload: EmailPayload) {
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
      "Idempotency-Key": crypto.randomUUID(),
    },
    body: JSON.stringify({
      from: env.RESEND_FROM_EMAIL,
      to: [payload.to],
      subject: payload.subject,
      html: payload.html,
      text: payload.text,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Resend request failed: ${response.status} ${body}`);
  }
}

function renderEmailShell(title: string, body: string): string {
  return `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#0f1115;color:#f3f4f6;font-family:Arial,sans-serif;">
    <div style="max-width:560px;margin:0 auto;padding:32px 20px;">
      <div style="border:1px solid #2b3139;border-radius:16px;padding:28px;background:#171b22;">
        <div style="font-size:24px;font-weight:700;margin-bottom:16px;">${escapeHtml(title)}</div>
        ${body}
      </div>
    </div>
  </body>
</html>`;
}

export async function sendVerificationEmail(
  env: Pick<Env, "APP_NAME" | "RESEND_API_KEY" | "RESEND_FROM_EMAIL">,
  data: { email: string; name: string; url: string },
) {
  const appName = env.APP_NAME || "BladeVault";
  const greeting = data.name ? `Hi ${escapeHtml(data.name)},` : "Hi,";
  const html = renderEmailShell(
    `Verify your ${appName} email`,
    `<p style="margin:0 0 16px;line-height:1.6;">${greeting}</p>
<p style="margin:0 0 16px;line-height:1.6;">Finish creating your account by verifying your email address.</p>
<p style="margin:24px 0;"><a href="${data.url}" style="display:inline-block;background:#f59e0b;color:#111827;text-decoration:none;padding:12px 18px;border-radius:10px;font-weight:700;">Verify email</a></p>
<p style="margin:0;color:#9ca3af;line-height:1.6;">If you did not request this, you can ignore this email.</p>`,
  );

  await sendTransactionalEmail(env, {
    to: data.email,
    subject: `Verify your ${appName} account`,
    html,
    text: `Verify your ${appName} account by opening this link: ${data.url}`,
  });
}

export async function sendResetPasswordEmail(
  env: Pick<Env, "APP_NAME" | "RESEND_API_KEY" | "RESEND_FROM_EMAIL">,
  data: { email: string; name: string; url: string },
) {
  const appName = env.APP_NAME || "BladeVault";
  const greeting = data.name ? `Hi ${escapeHtml(data.name)},` : "Hi,";
  const html = renderEmailShell(
    `Reset your ${appName} password`,
    `<p style="margin:0 0 16px;line-height:1.6;">${greeting}</p>
<p style="margin:0 0 16px;line-height:1.6;">Use the button below to choose a new password.</p>
<p style="margin:24px 0;"><a href="${data.url}" style="display:inline-block;background:#f59e0b;color:#111827;text-decoration:none;padding:12px 18px;border-radius:10px;font-weight:700;">Reset password</a></p>
<p style="margin:0;color:#9ca3af;line-height:1.6;">If you did not request this, you can ignore this email.</p>`,
  );

  await sendTransactionalEmail(env, {
    to: data.email,
    subject: `Reset your ${appName} password`,
    html,
    text: `Reset your ${appName} password by opening this link: ${data.url}`,
  });
}
