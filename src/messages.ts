/**
 * Pure event -> message mapping.
 * Kept free of OpenCode client types so it is easy to unit-test
 * and resilient to schema additions.
 */

export const DEFAULT_NOTIFY_ON = [
  "permission.asked",
  "form.created",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
] as const;

export function matchesNotifyOn(type: string, notifyOn: readonly string[]): boolean {
  if (notifyOn.includes(type)) return true;
  for (const pattern of notifyOn) {
    if (pattern.endsWith(".*") && type.startsWith(pattern.slice(0, -1))) return true;
  }
  return false;
}

export function shortID(id: unknown, length = 8): string {
  if (typeof id !== "string") return "?";
  return id.length > length ? id.slice(0, length) : id;
}

export function dirBasename(path: unknown): string {
  if (typeof path !== "string" || path.length === 0) return "";
  const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1] ?? "";
}

function sessionSuffix(data: any, location: any): string {
  const sessionID = data?.sessionID;
  const dir = location?.directory ?? data?.location?.directory;
  const bits: string[] = [];
  if (sessionID !== undefined) bits.push(`session ${shortID(sessionID)}`);
  const base = dirBasename(dir);
  if (base) bits.push(base);
  return bits.length > 0 ? `\n${bits.join(" · ")}` : "";
}

function questionLines(form: any): string {
  const fields = Array.isArray(form?.fields) ? form.fields : [];
  return fields
    .slice(0, 4)
    .map((field: any, index: number) => {
      const title = field?.title ?? field?.key ?? `q${index}`;
      const description = field?.description;
      return description && description !== title ? `${index + 1}. ${title}: ${description}` : `${index + 1}. ${title}`;
    })
    .join("\n");
}

/**
 * Returns the Telegram text for an event, or null when it should be skipped.
 * `sessionTitle` is an optional enrichment resolved by the caller via
 * `ctx.session.get()`; it is appended when present.
 */
export function buildMessage(event: any, sessionTitle?: string): string | null {
  const type = event?.type;
  if (typeof type !== "string") return null;
  const data = event?.data ?? {};
  const location = event?.location;
  const titleSuffix = sessionTitle ? `\n“${sessionTitle}”` : "";

  switch (type) {
    case "permission.asked": {
      const action = data?.action ?? "unknown action";
      const resources = Array.isArray(data?.resources) ? data.resources.slice(0, 3).join(", ") : "";
      const message = typeof data?.message === "string" && data.message ? `\n${data.message}` : "";
      return (
        `🔐 OpenCode needs permission\nAction: ${action}` +
        (resources ? `\nResources: ${resources}` : "") +
        message +
        titleSuffix +
        sessionSuffix(data, location)
      );
    }
    case "form.created": {
      const form = data?.form ?? {};
      const kind = form?.metadata?.kind ?? data?.form?.metadata?.kind;
      const header = kind === "question" || form?.title === "Questions" ? "❓ OpenCode question" : "📝 OpenCode input needed";
      const questions = questionLines(form);
      return `${header}\n${form?.title ?? "Form"}${titleSuffix}\n${questions}${sessionSuffix(data, location)}`.trim();
    }
    case "session.execution.succeeded":
      return `✅ Turn finished${titleSuffix}${sessionSuffix(data, location)}`;
    case "session.execution.failed": {
      const error = data?.error;
      const detail = typeof error?.message === "string" ? error.message : "";
      return `❌ Turn failed${detail ? `\n${detail.slice(0, 500)}` : ""}${titleSuffix}${sessionSuffix(data, location)}`;
    }
    case "session.execution.interrupted": {
      const reason = typeof data?.reason === "string" ? data.reason : "";
      return `⏸ Turn interrupted${reason ? ` (${reason})` : ""}${titleSuffix}${sessionSuffix(data, location)}`;
    }
    case "session.status": {
      if (data?.status?.type !== "idle") return null;
      return `💤 Session idle${titleSuffix}${sessionSuffix(data, location)}`;
    }
    case "session.idle":
      return `💤 Session idle${titleSuffix}${sessionSuffix(data, location)}`;
    case "session.step.failed": {
      const detail = typeof data?.error?.message === "string" ? data.error.message : "";
      return `⚠️ Step failed${detail ? `\n${detail.slice(0, 500)}` : ""}${titleSuffix}${sessionSuffix(data, location)}`;
    }
    case "session.compaction.ended":
      return `🗜 Compaction finished${titleSuffix}${sessionSuffix(data, location)}`;
    default:
      return null;
  }
}
