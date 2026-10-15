import { Plugin } from "@opencode/plugin";
import { buildMessage, DEFAULT_NOTIFY_ON, matchesNotifyOn } from "./messages.js";
import { sendTelegramMessage } from "./telegram.js";

interface TelegramPluginOptions {
  /** Bot token from @BotFather. Falls back to TELEGRAM_BOT_TOKEN. */
  botToken?: string;
  /** Alias of botToken. */
  token?: string;
  /** Single chat id. Falls back to TELEGRAM_CHAT_ID. */
  chatId?: string | number;
  /** Alias of chatId (OpenCode schema IDs use `ID` suffix). */
  chatID?: string | number;
  /** Multiple chat ids. */
  chatIds?: Array<string | number>;
  /** Alias of chatIds. */
  chatIDs?: Array<string | number>;
  /** Event types to notify on. Supports exact types and `prefix.*` wildcards. */
  notifyOn?: string[];
  /** Line prepended to every message, e.g. the machine name. */
  prefix?: string;
  /** Resolve session titles via ctx.session.get(). Default true. */
  includeSessionTitle?: boolean;
  /** Override for tests / self-hosted Bot API. */
  telegramApiBase?: string;
}

interface ResolvedConfig {
  token: string;
  chatIDs: Array<string | number>;
  notifyOn: string[];
  prefix: string;
  includeSessionTitle: boolean;
  apiBase: string;
}

function parseChatIDs(value: unknown): Array<string | number> {
  if (value === undefined || value === null || value === "") return [];
  if (Array.isArray(value)) return value.filter((v) => typeof v === "string" || typeof v === "number");
  if (typeof value === "number") return [value];
  if (typeof value === "string") {
    return value
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => (/^-?\d+$/.test(part) ? Number(part) : part));
  }
  return [];
}

export function resolveConfig(options: TelegramPluginOptions = {}): ResolvedConfig | null {
  const token = options.botToken ?? options.token ?? process.env.TELEGRAM_BOT_TOKEN ?? "";
  const chatIDs = [
    ...parseChatIDs(options.chatIDs ?? options.chatIds),
    ...parseChatIDs(options.chatId ?? options.chatID),
    ...parseChatIDs(process.env.TELEGRAM_CHAT_ID),
  ];
  if (!token || chatIDs.length === 0) return null;
  return {
    token,
    chatIDs: [...new Set(chatIDs)],
    notifyOn: options.notifyOn ?? [...DEFAULT_NOTIFY_ON],
    prefix: options.prefix ?? process.env.TELEGRAM_PREFIX ?? "",
    includeSessionTitle: options.includeSessionTitle ?? true,
    apiBase: options.telegramApiBase ?? process.env.TELEGRAM_API_BASE ?? "https://api.telegram.org",
  };
}

async function sessionTitle(ctx: { session: { get(input: any): Promise<any> } }, sessionID: unknown): Promise<string | undefined> {
  if (typeof sessionID !== "string" || sessionID.length === 0) return undefined;
  try {
    const session = await ctx.session.get({ sessionID });
    const title = (session as any)?.title ?? (session as any)?.data?.title;
    return typeof title === "string" && title.trim().length > 0 ? title.trim() : undefined;
  } catch {
    return undefined;
  }
}

// Best-effort same-process dedup. Instances that share this module (same
// server process) coordinate here with zero delay; anything else falls
// through to the location and storage checks below.
const seenEventIDs = new Set<string>();
const MAX_SEEN = 2000;

function markSeen(id: unknown): boolean {
  if (typeof id !== "string" || id.length === 0) return false;
  if (seenEventIDs.has(id)) return true;
  seenEventIDs.add(id);
  if (seenEventIDs.size > MAX_SEEN) {
    const oldest = seenEventIDs.values().next();
    if (!oldest.done) seenEventIDs.delete(oldest.value);
  }
  return false;
}

export function isOwnLocation(event: any, own: { directory: unknown; workspaceID?: unknown }): boolean | null {
  const location = event?.location;
  const directory = typeof location?.directory === "string" ? location.directory : undefined;
  if (!directory) return null; // no location attached: undecided
  if (String(directory) !== String(own.directory)) return false;
  const eventWorkspace = location?.workspaceID;
  const ownWorkspace = own.workspaceID;
  if (eventWorkspace != null && ownWorkspace != null && String(eventWorkspace) !== String(ownWorkspace)) return false;
  return true;
}

const CLAIM_PREFIX = "seen/";
const CLAIM_TTL_MS = 60 * 60 * 1000;
const CLAIM_SETTLE_MS = 1500;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

interface ClaimStorage {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
  scan(options: { prefix: string; limit?: number }): Promise<{ entries: ReadonlyArray<{ key: string; value: unknown }> }>;
}

async function pruneClaims(storage: ClaimStorage): Promise<void> {
  const page = await storage.scan({ prefix: CLAIM_PREFIX, limit: 100 });
  const now = Date.now();
  for (const entry of page.entries) {
    const at = (entry.value as any)?.at;
    if (typeof at !== "number" || now - at > CLAIM_TTL_MS) {
      await storage.remove(entry.key).catch(() => {});
    }
  }
}

// Single-sender election for events without a location. Every instance
// writes its claim, waits for late writers to land, then only the surviving
// (last) claim notifies.
async function claimEvent(storage: ClaimStorage, eventID: string, instanceID: string): Promise<boolean> {
  const key = CLAIM_PREFIX + eventID;
  try {
    await storage.set(key, { by: instanceID, at: Date.now() });
    await sleep(CLAIM_SETTLE_MS);
    const claim = (await storage.get(key)) as any;
    if (!claim || typeof claim !== "object" || claim.by !== instanceID) return false;
    void pruneClaims(storage).catch(() => {});
    return true;
  } catch (error) {
    console.warn("[opencode-v2-telegram-notify] claim storage failed, notifying anyway:", error);
    return true;
  }
}

export default Plugin.define({
  id: "opencode-v2-telegram-notify",
  async setup(ctx) {
    const config = resolveConfig((ctx.options ?? {}) as TelegramPluginOptions);
    if (!config) {
      console.warn(
        "[opencode-v2-telegram-notify] missing bot token or chat id; set plugins options {botToken, chatId} or TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID",
      );
      return;
    }

    console.log(
      `[opencode-v2-telegram-notify] listening for ${config.notifyOn.join(", ")} in ${ctx.location.directory} -> ${config.chatIDs.length} chat(s)`,
    );
    const controller = new AbortController();
    const instanceID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

    const handle = async (event: any) => {
      const type = event?.type;
      if (typeof type !== "string" || !matchesNotifyOn(type, config.notifyOn)) return;

      // Location affinity: the server runs one instance per loaded location
      // but every instance sees the global event stream, so only the
      // instance owning the event's location notifies.
      const affinity = isOwnLocation(event, ctx.location as any);
      if (affinity === false) return;

      // Same-process dedup: another instance already took this event.
      // Checked after affinity so merely observing someone else's event
      // does not consume it.
      if (markSeen(event?.id)) return;

      if (affinity === null) {
        const fallbackID = typeof event?.id === "string" ? event.id : `${type}:${event?.created ?? Date.now()}`;
        if (!(await claimEvent(ctx.storage as any, fallbackID, instanceID))) return;
      }

      let title: string | undefined;
      if (config.includeSessionTitle) {
        title = await sessionTitle(ctx as any, event?.data?.sessionID);
      }
      const body = buildMessage(event, title);
      if (!body) return;
      const text = config.prefix ? `${config.prefix}\n${body}` : body;
      try {
        await sendTelegramMessage({ apiBase: config.apiBase, token: config.token, chatIDs: config.chatIDs, text });
      } catch (error) {
        console.error(`[opencode-v2-telegram-notify] failed to send ${type}:`, error);
      }
    };

    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          void handle(event).catch((error) => console.error("[opencode-v2-telegram-notify] handler error:", error));
        }
      } catch (error) {
        if (!controller.signal.aborted) console.error("[opencode-v2-telegram-notify] event stream ended:", error);
      }
    })();

    return () => controller.abort();
  },
});
