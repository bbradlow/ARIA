const SLACK_API = "https://slack.com/api";

interface SlackResponse {
  ok: boolean;
  error?: string;
  [key: string]: unknown;
}

/**
 * Posts a message to a Slack channel (or user ID, which Slack resolves to the
 * user's DM channel automatically).
 *
 * Note: Slack returns HTTP 200 even for logical failures (e.g. `channel_not_found`,
 * `not_in_channel`), signalling the real outcome via the `ok` field — so we must
 * inspect the JSON body, not just the status code.
 */
export async function postSlackMessage(
  channel: string,
  text: string,
): Promise<SlackResponse> {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) throw new Error("Missing SLACK_BOT_TOKEN environment variable");

  const res = await fetch(`${SLACK_API}/chat.postMessage`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({ channel, text }),
  });

  const data = (await res.json()) as SlackResponse;
  if (!data.ok) {
    throw new Error(
      `Slack chat.postMessage failed: ${data.error ?? "unknown_error"}`,
    );
  }
  return data;
}

/**
 * Sends a direct message to a Slack user.
 * Passing a user ID (`U...`) as the channel lets Slack open/resolve the DM.
 */
export async function sendDM(slackUserId: string, text: string): Promise<void> {
  await postSlackMessage(slackUserId, text);
}
