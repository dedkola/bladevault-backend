import * as Sentry from "@sentry/cloudflare";
import type { Breadcrumb, CloudflareOptions, ErrorEvent } from "@sentry/cloudflare";
import type { Env } from "./env";

// Error reporting for the auth Worker. It is off unless SENTRY_DSN is set
// (`wrangler secret put SENTRY_DSN`). This service handles Google sign-in,
// session tokens, JWTs, and emails, so reports keep none of them.

const REDACTED = "[redacted]";

const TEXT_PATTERNS: Array<[RegExp, string]> = [
  [/\bBearer\s+[\w.~+/-]+=*/gi, `Bearer ${REDACTED}`],
  [/\beyJ[\w-]{6,}\.[\w-]{6,}\.[\w-]{6,}/g, REDACTED],
  [
    /\b(access_?token|session_?token|id_?token|refresh_?token|token|password|secret|api_?key|code|state|sentry_key)=([^&\s"'#]+)/gi,
    `$1=${REDACTED}`,
  ],
  [/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, "[email]"],
];

export function scrubText(value: string): string {
  let result = value;
  for (const [pattern, replacement] of TEXT_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

export function stripUrlQuery(url: string): string {
  const end = url.search(/[?#]/);
  return end === -1 ? url : url.slice(0, end);
}

export function scrubBreadcrumb(breadcrumb: Breadcrumb): Breadcrumb {
  const next: Breadcrumb = { ...breadcrumb };
  if (next.message) next.message = scrubText(next.message);
  if (next.data) {
    const { method, status_code, url } = next.data as Record<string, unknown>;
    const data: Record<string, unknown> = {};
    if (typeof method === "string") data.method = method;
    if (typeof status_code === "number") data.status_code = status_code;
    if (typeof url === "string") data.url = scrubText(stripUrlQuery(url));
    next.data = data;
  }
  return next;
}

export function scrubEvent(event: ErrorEvent): ErrorEvent {
  delete event.user;
  delete event.server_name;

  if (event.request) {
    const { method, url } = event.request;
    event.request = {
      ...(method ? { method } : {}),
      ...(url ? { url: scrubText(stripUrlQuery(url)) } : {}),
    };
  }

  if (event.message) event.message = scrubText(event.message);

  for (const exception of event.exception?.values ?? []) {
    if (exception.value) exception.value = scrubText(exception.value);
    for (const frame of exception.stacktrace?.frames ?? []) {
      delete frame.vars;
    }
  }

  if (event.breadcrumbs) {
    event.breadcrumbs = event.breadcrumbs.map(scrubBreadcrumb);
  }

  return event;
}

type SentryLog = Parameters<NonNullable<CloudflareOptions["beforeSendLog"]>>[0];
type SentryMetric = Parameters<NonNullable<CloudflareOptions["beforeSendMetric"]>>[0];

// Logs and metric attributes get the same text scrubbing as error events.
function scrubAttributes<T extends Record<string, unknown> | undefined>(attributes: T): T {
  if (!attributes) return attributes;
  return Object.fromEntries(
    Object.entries(attributes).map(([key, value]) => [key, typeof value === "string" ? scrubText(value) : value]),
  ) as T;
}

export function scrubLog(log: SentryLog): SentryLog {
  return {
    ...log,
    message: typeof log.message === "string" ? scrubText(log.message) : log.message,
    attributes: scrubAttributes(log.attributes),
  };
}

export function scrubMetric(metric: SentryMetric): SentryMetric {
  return { ...metric, attributes: scrubAttributes(metric.attributes) };
}

export type SignInStartResult = "ok" | "invalid_request" | "invalid_origin" | "start_failed";
export type SignInCompleteResult = "ok" | "invalid_origin" | "no_session" | "token_failed";

// Counts each popup sign-in step by outcome. No user, email, or origin is attached.
export function recordSignInStart(result: SignInStartResult) {
  Sentry.metrics.count("auth.signin.start", 1, { attributes: { result } });
  if (result === "start_failed") {
    Sentry.logger.warn("Popup sign-in could not start", { result });
  }
}

export function recordSignInComplete(result: SignInCompleteResult) {
  Sentry.metrics.count("auth.signin.complete", 1, { attributes: { result } });
  if (result !== "ok") {
    Sentry.logger.warn("Popup sign-in did not complete", { result });
  }
}

export function getSentryOptions(env: Env): CloudflareOptions {
  const dsn = env.SENTRY_DSN?.trim();
  return {
    dsn,
    enabled: Boolean(dsn),
    environment: env.SENTRY_ENVIRONMENT?.trim() || "production",
    // Release comes from SENTRY_RELEASE or the CF_VERSION_METADATA binding.
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      databaseQueryData: false,
      queues: false,
      stackFrameVariables: false,
    },
    tracesSampleRate: 0,
    initialScope: { tags: { service: "auth-worker" } },
    beforeSend: (event) => scrubEvent(event),
    beforeBreadcrumb: (breadcrumb) => scrubBreadcrumb(breadcrumb),
    beforeSendLog: (log) => scrubLog(log),
    beforeSendMetric: (metric) => scrubMetric(metric),
  };
}
