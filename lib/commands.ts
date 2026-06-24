import { getSupabase } from "@/lib/supabase";
import { retrieve } from "@/lib/retrieval";

// Names that can't be used as custom commands: built-in handlers + the
// management verbs below. Keeps users from shadowing core functionality.
const RESERVED = new Set([
  "joke", "all",
  "def", "undef", "delete", "remove", "commands", "list", "help",
  "subscribe", "unsubscribe", "start", "stop",
]);

export function isReservedName(name: string): boolean {
  return RESERVED.has(name.toLowerCase());
}

export interface CustomCommand {
  name: string;
  prompt: string;
  uses_research: boolean;
  created_by: string | null;
}

export async function defineCommand(
  name: string,
  prompt: string,
  userId: string,
  usesResearch = false
): Promise<void> {
  const sb = getSupabase();
  const { error } = await sb.from("custom_commands").upsert(
    { name: name.toLowerCase(), prompt, uses_research: usesResearch, created_by: userId },
    { onConflict: "name" }
  );
  if (error) throw new Error(error.message);
}

export async function deleteCommand(name: string): Promise<void> {
  const sb = getSupabase();
  const { error } = await sb.from("custom_commands").delete().eq("name", name.toLowerCase());
  if (error) throw new Error(error.message);
}

export async function getCommand(name: string): Promise<CustomCommand | null> {
  const sb = getSupabase();
  const { data } = await sb
    .from("custom_commands")
    .select("name,prompt,uses_research,created_by")
    .eq("name", name.toLowerCase())
    .maybeSingle();
  return (data as CustomCommand) ?? null;
}

export async function listCommands(): Promise<CustomCommand[]> {
  const sb = getSupabase();
  const { data } = await sb
    .from("custom_commands")
    .select("name,prompt,uses_research,created_by")
    .order("name");
  return (data as CustomCommand[]) ?? [];
}

// Run a custom command: expand its prompt with the caller's input and send it
// to the model. Optionally grounds the answer in the research library. Text
// only — no code execution, CRM access, or web browsing.
export async function runCustomCommand(cmd: CustomCommand, args: string): Promise<string> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("Missing OPENROUTER_API_KEY environment variable");
  const model = process.env.QA_MODEL?.trim() || "anthropic/claude-sonnet-4-5";

  let research = "";
  if (cmd.uses_research && args) {
    try {
      const chunks = await retrieve(args, 6);
      research = chunks.map((c) => `[${c.article_title}] ${c.content}`).join("\n\n---\n\n");
    } catch {
      // research is best-effort
    }
  }

  // {input} is substituted with the caller's text; otherwise it's appended.
  const userContent = cmd.prompt.includes("{input}")
    ? cmd.prompt.replace(/\{input\}/g, args || "")
    : args
    ? `${cmd.prompt}\n\n${args}`
    : cmd.prompt;

  const messages: { role: string; content: string }[] = [
    {
      role: "system",
      content:
        "You are ARIA, an assistant for Activant Capital, running a user-defined command. Follow the instruction faithfully. Be concise and use Slack formatting (single asterisks for *bold*, never markdown headers). You can only produce text — you cannot run code, access the CRM, or browse the web.",
    },
  ];
  if (research) messages.push({ role: "system", content: `Relevant research excerpts:\n${research}` });
  messages.push({ role: "user", content: userContent });

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://activantcapital.com",
      "X-Title": "Activant Research Bot",
    },
    body: JSON.stringify({ model, messages }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`OpenRouter request failed (${res.status}): ${t}`);
  }
  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const out = data.choices?.[0]?.message?.content?.trim();
  if (!out) throw new Error("OpenRouter returned an empty response");
  return out;
}
