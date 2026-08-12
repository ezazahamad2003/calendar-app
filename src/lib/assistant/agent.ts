import "server-only";

import { getEnv, requireEnv } from "@/lib/env";
import { planSchema } from "@/lib/ops/schema";
import type { Plan } from "@/lib/ops/schema";
import type { AssistantContext } from "./context";

/**
 * The assistant.
 *
 * A tool-calling loop around one POST, with a hard asymmetry at its centre:
 * it can read everything and change nothing. `propose_changes` returns a diff
 * for a person to confirm; there is no tool that writes. A model that can send
 * an email directly will eventually send the wrong subcontractor the wrong
 * week, and that lands on a real business as a wasted day and a difficult
 * phone call.
 *
 * Plain fetch, no SDK — a tool loop is a while loop around one request.
 */

export class AgentError extends Error {}

export type Turn = {
  role: "user" | "assistant" | "tool";
  content: string;
  toolCalls?: { id: string; name: string; args: string }[];
  toolCallId?: string;
};

export type AgentResult = {
  /** What to say back. Always present, even alongside a proposal. */
  reply: string;
  plan: Plan | null;
  turns: Turn[];
};

type ApiMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
};

const MAX_ROUNDS = 5;
const MAX_HISTORY = 40;

const PROPOSE_TOOL = {
  type: "function" as const,
  function: {
    name: "propose_changes",
    description:
      "Propose changes to the schedule. This does NOT apply anything — the user " +
      "sees a diff and confirms. Call it only when the user wants something changed.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        summary: { type: "string", description: "One sentence, read back to the user." },
        reason: {
          type: ["string", "null"],
          description:
            "Why the schedule is changing, in words a subcontractor will read in an " +
            "email: 'Framing crew did not show'. Null if the user gave no reason.",
        },
        operations: { type: "array", items: { type: "object", additionalProperties: true } },
        clarification: {
          type: ["string", "null"],
          description: "A blocking question. If set, operations must be empty.",
        },
        notes: { type: ["string", "null"], description: "What you left out, and why." },
        confidence: { type: "string", enum: ["high", "low"] },
      },
      required: ["summary", "operations", "confidence"],
    },
  },
};

function systemPrompt(ctx: AssistantContext): string {
  return [
    `You are the scheduling assistant for "${ctx.projectName}"${
      ctx.client ? `, a job for ${ctx.client}` : ""
    }.`,
    "You talk like a competent site manager: short, concrete, no filler. No bullet lists unless asked.",
    "",
    `Today is ${ctx.today} in ${ctx.timezone}. Working days (ISO, 1=Mon..7=Sun): ${ctx.workingDays.join(",")}.`,
    "",
    "HOW YOU WORK",
    "- Most turns are questions. Answer them from the CONTEXT below. Only call propose_changes when the user wants something CHANGED.",
    "- When they DO want something changed, call propose_changes in the SAME turn. Never ask \"shall I go ahead?\" or \"let me know if you want to proceed\" — the app already shows a diff and asks for confirmation. Asking as well makes him say it twice.",
    "- Never claim you changed, moved, sent or booked anything. You propose; the user confirms; only then is it real. Say \"that'll move the downspouts\", never \"I've moved the downspouts\".",
    "- Your reply is ONE short line saying what you are proposing. Do not list the knock-on effects and do not name any activity that is not in the CONTEXT below — the app works out what else moves and shows it. Inventing a consequence is worse than saying nothing, because he reads your line and not the diff.",
    "- NEVER describe a change you cannot express with the operations below. If the user asks for something outside them, say plainly that you cannot do it. Reaching for the nearest operation you DO have is the worst option available.",
    "- ADDING IS NOT MOVING. \"Add downspouts Tuesday\", \"put paving in next week\", \"book Whirco Friday\" all CREATE a new activity with add_activity, even when a similarly-named one already exists. Only move an existing one when the user refers to it AND asks for its date to change: \"push the downspouts back\", \"move the final inspection to Friday\".",
    "- Fuzzy matching decides WHICH activity they mean, never WHETHER they meant a new one. If in doubt, add — a duplicate row is an easy delete, a silently moved crew booking is a wasted day on site.",
    "- Follow-ups are normal. \"Make it Wednesday instead\" refers to what you just proposed; re-propose the whole corrected change.",
    "",
    "THE COMMON REQUEST",
    "- \"They didn't show\", \"they never came\", \"they're a day behind\", \"push it two days\" all mean push_activity with byDays in WORKING days. Two days is byDays 2, a week is 5, two weeks is 10.",
    "- You do NOT work out the resulting dates. push_activity says how far; the app does the arithmetic against the working calendar and cascades everything downstream. Never state a computed date you were not given — the diff shows the real ones.",
    "- Everything linked after the pushed activity moves with it automatically. Do not add operations for the knock-on effects; that would move them twice.",
    "",
    "REASONS",
    "- When something moves, the people it affects get an email, and that email quotes the reason. So capture it: \"they didn't show\" → reason \"Crew did not arrive on site\". Put it in `reason`, in words a subcontractor can read without offence.",
    "- If the user gave no reason at all, set reason to null. Do not invent one.",
    "",
    "STATUS MARKS (they match the wall chart)",
    "- confirmed = booked with the trade (X on the chart). tentative = pencilled in (?). done = finished (D). planned = real work with no date yet. blocked = cannot proceed.",
    "",
    "RULES FOR propose_changes",
    "- Every taskId, sectionId and contactId must come from the CONTEXT below. NEVER invent one. An invented id is rejected and you will be asked to try again.",
    "- Set clarification ONLY when you genuinely cannot proceed — two activities match equally well, or you need an address nobody has given. It cancels everything, so it must be rare. Ask in your reply instead where you can.",
    "- Set notes for what you dropped while doing the rest.",
    "- confidence: 'low' if you fuzzy-matched something that matters, or the transcript was garbled.",
    "- Never guess an email address. If a contact has hasEmail false, say so — do not make one up in update_contact.",
    "",
    "Operation shapes:",
    `  {"type":"push_activity","taskId":"","byDays":2}          // + is later, - is earlier. WORKING days.`,
    `  {"type":"move_activity","taskId":"","startDate":"YYYY-MM-DD"}`,
    `  {"type":"resize_activity","taskId":"","durationDays":1}`,
    `  {"type":"clear_dates","taskId":""}                       // back to the undated backlog`,
    `  {"type":"set_status","taskId":"","status":"planned|tentative|confirmed|done|blocked"}`,
    `  {"type":"add_activity","sectionId":null,"name":"","team":null,"startDate":null,"durationDays":1,"status":"planned","after":[]}`,
    `  {"type":"remove_activity","taskId":""}`,
    `  {"type":"rename_activity","taskId":"","name":""}`,
    `  {"type":"set_team","taskId":"","team":"","contactId":null}`,
    `  {"type":"set_notes","taskId":"","notes":""}`,
    `  {"type":"add_dependency","predecessorId":"","successorId":"","depType":"FS","lagDays":0}`,
    `  {"type":"remove_dependency","predecessorId":"","successorId":""}`,
    `  {"type":"add_contact","name":"","company":null,"trade":null,"email":null,"phone":null}`,
    `  {"type":"update_contact","contactId":"","name":null,"company":null,"trade":null,"email":null,"phone":null}`,
    "",
    "CONTEXT — the whole job. Activities are in chart order. `end` is already computed for you.",
    JSON.stringify({
      sections: ctx.sections,
      tasks: ctx.tasks,
      deps: ctx.deps,
      contacts: ctx.contacts,
      holidays: ctx.holidays,
    }),
  ].join("\n");
}

function toApiMessages(turns: Turn[]): ApiMessage[] {
  return turns.map((t) => {
    if (t.role === "tool") {
      return { role: "tool" as const, content: t.content, tool_call_id: t.toolCallId };
    }
    if (t.role === "assistant" && t.toolCalls?.length) {
      return {
        role: "assistant" as const,
        content: t.content || null,
        tool_calls: t.toolCalls.map((c) => ({
          id: c.id,
          type: "function" as const,
          function: { name: c.name, arguments: c.args },
        })),
      };
    }
    return { role: t.role, content: t.content };
  });
}

type ChoiceMessage = {
  content?: string | null;
  tool_calls?: { id: string; function: { name: string; arguments: string } }[];
};

async function complete(messages: ApiMessage[]): Promise<ChoiceMessage> {
  let res: Response;
  try {
    res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${requireEnv("OPENAI_API_KEY")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: getEnv().OPENAI_PLANNER_MODEL,
        temperature: 0.2,
        messages,
        tools: [PROPOSE_TOOL],
        tool_choice: "auto",
      }),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (err) {
    throw new AgentError(
      err instanceof Error && err.name === "TimeoutError"
        ? "The assistant took too long to answer. Try again."
        : "Could not reach the assistant. Check your signal and try again.",
    );
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new AgentError(
      `The assistant did not answer (HTTP ${res.status}). Try again in a moment.` +
        (detail ? ` Detail: ${detail.slice(0, 200)}` : ""),
    );
  }

  const payload = (await res.json()) as { choices?: { message?: ChoiceMessage }[] };
  const message = payload.choices?.[0]?.message;
  if (!message) throw new AgentError("The assistant returned an empty response.");
  return message;
}

/**
 * One user turn: answer, or propose.
 *
 * `history` comes back from the browser and is therefore untrusted. It cannot
 * do damage — there is no tool that writes, and the confirm path revalidates
 * every id from scratch against freshly read state — but it is capped and
 * reshaped here rather than passed through as-is.
 */
export async function converse(
  userText: string,
  history: Turn[],
  ctx: AssistantContext,
): Promise<AgentResult> {
  const turns: Turn[] = [
    ...history.slice(-MAX_HISTORY),
    { role: "user", content: userText },
  ];

  let proposed: Plan | null = null;
  let reply = "";

  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    const message = await complete([
      { role: "system", content: systemPrompt(ctx) },
      ...toApiMessages(turns),
    ]);

    const calls = message.tool_calls ?? [];
    const text = message.content ?? "";

    if (calls.length === 0) {
      reply = text.trim();
      turns.push({ role: "assistant", content: reply });
      break;
    }

    turns.push({
      role: "assistant",
      content: text,
      toolCalls: calls.map((c) => ({
        id: c.id,
        name: c.function.name,
        args: c.function.arguments,
      })),
    });

    for (const call of calls) {
      if (call.function.name !== "propose_changes") {
        turns.push({
          role: "tool",
          toolCallId: call.id,
          content: JSON.stringify({ error: `There is no tool called ${call.function.name}.` }),
        });
        continue;
      }

      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(call.function.arguments || "{}") as Record<string, unknown>;
      } catch {
        turns.push({
          role: "tool",
          toolCallId: call.id,
          content: JSON.stringify({ error: "Arguments were not valid JSON." }),
        });
        continue;
      }

      const parsed = planSchema.safeParse({
        summary: args.summary,
        reason: args.reason ?? null,
        operations: args.operations ?? [],
        notes: args.notes ?? null,
        clarification: args.clarification ?? null,
        confidence: args.confidence === "low" ? "low" : "high",
      });

      if (!parsed.success) {
        const problems = parsed.error.issues
          .slice(0, 3)
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ");
        // Handed back as a tool result so the model can correct itself, which
        // works far more often than asking the user to rephrase.
        turns.push({
          role: "tool",
          toolCallId: call.id,
          content: JSON.stringify({
            error: `That proposal did not match the schema: ${problems}. Fix it and call propose_changes again.`,
          }),
        });
        continue;
      }

      proposed = parsed.data;
      turns.push({
        role: "tool",
        toolCallId: call.id,
        content: JSON.stringify({
          ok: true,
          note:
            "Proposal accepted and shown to the user for confirmation. Do not call " +
            "propose_changes again this turn. Reply with one short line describing it.",
        }),
      });
    }
  }

  if (!reply) {
    reply = proposed
      ? "Here's what that would change — have a look before confirming."
      : "I couldn't work that one out. Try saying it a different way.";
    turns.push({ role: "assistant", content: reply });
  }

  return { reply, plan: proposed, turns: turns.slice(-MAX_HISTORY) };
}
