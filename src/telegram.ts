export const TELEGRAM_API_BASE = "https://api.telegram.org";
export const TELEGRAM_MAX_TEXT = 4096;

export interface SendOptions {
  apiBase?: string;
  token: string;
  chatIDs: Array<string | number>;
  text: string;
  signal?: AbortSignal;
}

/** Truncate to Telegram's 4096-character message limit. */
export function truncate(text: string, max = 4000): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + "…";
}

export async function sendTelegramMessage(options: SendOptions): Promise<void> {
  const base = (options.apiBase ?? TELEGRAM_API_BASE).replace(/\/+$/, "");
  const text = truncate(options.text);
  for (const chatID of options.chatIDs) {
    const url = `${base}/bot${options.token}/sendMessage`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatID,
        text,
        disable_web_page_preview: true,
      }),
      signal: options.signal,
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Telegram sendMessage failed (${response.status}): ${body.slice(0, 300)}`);
    }
  }
}
