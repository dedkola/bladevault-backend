import os from "node:os";

// Error reporting for the backup server. It is off unless SENTRY_DSN is set
// in .env. Requests carry bearer JWTs and backup archives, so reports keep
// no headers, bodies, query strings, user details, or host name.

const REDACTED = "[redacted]";

const TEXT_PATTERNS = [
  [/\bBearer\s+[\w.~+/-]+=*/gi, `Bearer ${REDACTED}`],
  [/\beyJ[\w-]{6,}\.[\w-]{6,}\.[\w-]{6,}/g, REDACTED],
  [
    /\b(access_?token|session_?token|token|password|secret|api_?key|code|sentry_key)=([^&\s"'#]+)/gi,
    `$1=${REDACTED}`,
  ],
  [/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, "[email]"],
];

let sentry = null;

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function scrubText(value, homeDir = os.homedir()) {
  if (typeof value !== "string") return value;
  let result = value;
  const home = typeof homeDir === "string" ? homeDir.replace(/[\\/]+$/, "") : "";
  if (home.length > 1) {
    result = result.replace(new RegExp(escapeRegExp(home), "g"), "~");
  }
  for (const [pattern, replacement] of TEXT_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

function stripUrlQuery(url) {
  const end = url.search(/[?#]/);
  return end === -1 ? url : url.slice(0, end);
}

export function scrubBreadcrumb(breadcrumb) {
  const next = { ...breadcrumb };
  if (next.message) next.message = scrubText(next.message);
  if (next.data) {
    const { method, status_code: statusCode, url } = next.data;
    const data = {};
    if (typeof method === "string") data.method = method;
    if (typeof statusCode === "number") data.status_code = statusCode;
    if (typeof url === "string") data.url = scrubText(stripUrlQuery(url));
    next.data = data;
  }
  return next;
}

export function scrubEvent(event) {
  delete event.user;
  delete event.server_name;

  if (event.request) {
    const { method, url } = event.request;
    event.request = {};
    if (method) event.request.method = method;
    if (url) event.request.url = scrubText(stripUrlQuery(url));
  }

  if (event.message) event.message = scrubText(event.message);

  for (const exception of event.exception?.values ?? []) {
    if (exception.value) exception.value = scrubText(exception.value);
    for (const frame of exception.stacktrace?.frames ?? []) {
      delete frame.vars;
      if (frame.filename) frame.filename = scrubText(frame.filename);
      if (frame.abs_path) frame.abs_path = scrubText(frame.abs_path);
    }
  }

  if (event.breadcrumbs) {
    event.breadcrumbs = event.breadcrumbs.map(scrubBreadcrumb);
  }

  return event;
}

function scrubAttributes(attributes) {
  if (!attributes) return attributes;
  return Object.fromEntries(
    Object.entries(attributes).map(([key, value]) => [key, typeof value === "string" ? scrubText(value) : value]),
  );
}

export function scrubLog(log) {
  return {
    ...log,
    message: typeof log.message === "string" ? scrubText(log.message) : log.message,
    attributes: scrubAttributes(log.attributes),
  };
}

export function scrubMetric(metric) {
  return { ...metric, attributes: scrubAttributes(metric.attributes) };
}

export function getSentryOptions(env, version) {
  const dsn = env.SENTRY_DSN?.trim();
  if (!dsn || !dsn.startsWith("https://")) return null;

  return {
    dsn,
    environment: env.SENTRY_ENVIRONMENT?.trim() || "production",
    release: env.SENTRY_RELEASE?.trim() || `bladevault-backup-server@${version}`,
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
    initialScope: { tags: { service: "backup-server" } },
    beforeSend: (event) => scrubEvent(event),
    beforeBreadcrumb: (breadcrumb) => scrubBreadcrumb(breadcrumb),
    beforeSendLog: (log) => scrubLog(log),
    beforeSendMetric: (metric) => scrubMetric(metric),
  };
}

// Loads the SDK only when a DSN is configured.
export async function initSentry(env, version) {
  const options = getSentryOptions(env, version);
  if (!options) return false;
  sentry = await import("@sentry/node");
  sentry.init({
    ...options,
    // Existing console.warn/console.error lines become Sentry logs.
    integrations: [sentry.consoleLoggingIntegration({ levels: ["warn", "error"] })],
  });
  return true;
}

// Unexpected failures only: callers skip expected 4xx responses.
export function reportServerError(error, route) {
  if (!sentry) return;
  sentry.withScope((scope) => {
    scope.setTag("route", route);
    sentry.captureException(error);
  });
}

// Counts a backup upload or download by outcome, with the archive size for
// successful transfers. No user ID or file name is attached.
export function recordBackupTransfer(kind, result, sizeBytes) {
  if (!sentry) return;
  sentry.metrics.count(`backup.${kind}`, 1, { attributes: { result } });
  if (result === "ok" && Number.isFinite(sizeBytes)) {
    sentry.metrics.distribution(`backup.${kind}.size`, sizeBytes, { unit: "byte" });
  }
}

export function recordAuthRejected() {
  if (!sentry) return;
  sentry.metrics.count("backup.auth.rejected", 1);
}
