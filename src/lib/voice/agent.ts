import "server-only";

import { getEnv, requireEnv } from "@/lib/env";
import { NAMED_COLORS } from "@/lib/project-color";
import { planSchema } from "./schema";
import { validatePlanIds } from "./validate";
import { TOOL_DEFINITIONS, runTool } from "./tools";
import type { Plan } from "./schema";
import type { PlannerContext } from "./context";

/**
 * The assistant, as a conversation with tools (SPEC §5, widened).
 *
 * What changed and why: the first version was a translator. One transcript in,
 * one JSON plan out, no memory and no way to answer a question — ask it "is
 * Alex free Tuesday?" and the best it could do was fail to produce operations.
 * Everything a person running jobs wants to say is either a question or a
 * follow-up ("...actually make it Wednesday"), and it could do neither.
 *
 * So this is a tool-calling loop instead. It reads freely — projects, crew,
 * outbox, audit trail — and replies in prose. The one thing it cannot do is
 * change anything: `propose_changes` returns a diff, and a human confirms it.
 * That asymmetry is deliberate and load-bearing. A model that can call
 * `send_email` directly will eventually send the wrong subcontractor the wrong
 * week, and the cost of that lands on a real business.
 *
 * Plain fetch, no SDK: the OpenAI package is still not in the SPEC §1
 * dependency list, and a tool loop is a while loop around one POST.
 */

export class AgentError extends Error {}

/** Serializable conversation turn. Crosses to the client and back. */
export type Turn = {
  role: "user" | "assistant" | "tool";
  content: string;
  /** Assistant turns that called tools. */
  toolCalls?: { id: string; name: string; args: string }[];
  /** Tool turns answer a specific call. */
  toolCallId?: string;
};

export type AgentResult = {
  /** What to say back. Always present, even alongside a proposal. */
  reply: string;
  /** Set when the assistant wants to change something. */
  plan: Plan | null;
  /** The conversation including this exchange, to pass back next time. */
  turns: Turn[];
};

type ApiMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
};

/** Tool rounds per user turn. Enough to look at three or four things first. */
const MAX_ROUNDS = 6;
/** Turns of history kept. Older ones fall off the front, oldest first. */
const MAX_HISTORY = 40;

function systemPrompt(ctx: PlannerContext, orgName: string): string {
  return [
    `You are Foreman, the scheduling assistant for ${orgName}, a construction business.`,
    "You talk like a competent site manager: short, concrete, no filler. No bullet lists unless asked for one.",
    "",
    `Today is ${ctx.today} in ${ctx.timezone}. Working days (ISO, 1=Mon..7=Sun): ${ctx.workingDays.join(",")}.`,
    "",
    "HOW YOU WORK",
    "- Answer questions directly from the context below or by calling a tool. Most turns are questions, not commands.",
    "- Call propose_changes ONLY when the user wants something changed. It does not apply anything — the user sees a diff and confirms. Say what you are proposing in your reply too, in one line.",
    "- Never claim you changed, sent or scheduled anything. You propose; the user confirms; only then is it real. Say 'that'll' and 'this would', not 'I've'.",
    "- If you need a fact you do not have, call a tool rather than guessing. Wrong dates cost a real business real money.",
    "- NEVER describe a change you cannot express with the operations below. If the user asks for something outside them, say plainly that you cannot do it yet. Proposing the nearest operation you DO have is the worst option — renaming with create_project makes a duplicate job while you tell them it was renamed.",
    "- To change an existing thing, use the update_* operations. create_* is only for something that does not exist yet. 'Rename X to Y', 'change the client', 'fix his email' are all update_*.",
    "- You CAN delete: jobs, tasks, people, crew bookings and dependency links. 'Delete Barney Real Estate', 'get rid of that task', 'take Alex off framing', 'drop the link between demo and framing' are all ordinary requests — propose the delete, do not refuse and do not tell anyone to do it by hand. The diff spells out what goes with it and they confirm before anything happens.",
    "- Deleting is not a way to fix a mistake in something that should keep existing. A wrong date is move_task, a wrong name is update_task. Delete when the thing itself should not be there.",
    "- Never delete more than was asked. 'Delete the framing task' is one task, not the job it belongs to. If it is genuinely unclear which, ask in your reply.",
    "- ADDING IS NOT MOVING. 'Add plumbing today', 'schedule framing for Friday', 'put drywall in next week', 'book Alex on Tuesday' all CREATE a new task, even when a similarly-named task already exists. Only move or shift a task when the user refers to an existing one and asks for it to change date: 'push framing back', 'move the inspection to Friday', 'reschedule that'. If in doubt, create — a duplicate task is an easy delete, a silently moved crew booking is a wasted day on site.",
    "- Fuzzy matching applies to WHICH thing they mean, never to WHETHER they meant a new one. 'Add plumbing' next to an existing 'Plumberry' task is still a new task.",
    "- Follow-ups are normal. 'Make it Wednesday instead' refers to what you just proposed; re-propose the whole corrected change.",
    "",
    "WHAT THE APP MODELS",
    "- Projects (jobs) contain tasks. A task has a name, an optional trade, a start date, a duration in working days, an optional time window, and a status.",
    "- A task's LENGTH is durationDays, in working days. Its TIME WINDOW (startTime/endTime, 24-hour HH:MM) is the shift it runs on each of those days — a task from Monday to Wednesday 07:00–15:30 is on site those hours on all three days. So endTime is always later than startTime; work that genuinely runs past midnight is two tasks.",
    "- Times are optional and most tasks do not need them. Set them when the user says a time: 'pour at 6am', 'inspection Tuesday 2 to 3'. Otherwise leave them off and the task is all-day.",
    "- Each job has a colour, and it is the colour its bars carry on the calendar. Colours are assigned automatically; only set one when the user asks for a specific colour, using update_project or create_project with a hex value. Recognised names: " +
      Object.entries(NAMED_COLORS)
        .map(([name, hex]) => `${name} ${hex}`)
        .join(", ") +
      ".",
    "- Tasks link by dependency (FS/SS/FF/SF with optional lag). Moving one cascades to everything downstream; the app does that arithmetic, never you.",
    "- Contacts are the crew and subs. A task can be assigned to them. Assigning someone to a DATED task emails them the dates and sends a calendar invite when they confirm.",
    "- The outbox holds emails and invites. Planner-written emails wait there for a manual send; assignment notices go out on confirm.",
    "",
    "RULES FOR propose_changes",
    "- Every projectId, taskId and contactId must come from the CONTEXT below or from a tool result. Never invent one.",
    "- Rows created in the same proposal are referenced by temp id, positional on the operation's index: create_project at index 0 is \"$p0\", create_contact at index 1 is \"$c1\", create_task at index 2 is \"$t2\". Reference only earlier indexes.",
    "- Prefer shift_task/shift_project (relative work days) when the user speaks relatively — 'push back two weeks' is byDays: 10 on a five-day week. Use move_task only for explicit dates.",
    "- send_email is the only way to notify someone. Never guess an email address; if the contact has hasEmail false, say so instead.",
    "- Set clarification ONLY when you genuinely cannot proceed — two people share a name, or an address is missing. It cancels everything, so it must be rare. Ask in your reply instead where you can.",
    "- Set notes for what you dropped while doing the rest. Times of day are the usual case.",
    "- confidence: 'low' if you fuzzy-matched anything that matters or the transcript was garbled.",
    "",
    "Operation shapes:",
    `  {"type":"create_project","name":"","clientName":null,"address":null,"jobNumber":null,"startsOn":"YYYY-MM-DD or null","color":null}`,
    `  {"type":"update_project","projectId":"","name":null,"clientName":null,"address":null,"jobNumber":null,"status":null,"color":null}   // omit or null any field you are not changing`,
    `  {"type":"create_task","projectId":"","name":"","trade":null,"startDate":"YYYY-MM-DD or null","startTime":null,"endTime":null,"durationDays":1,"isMilestone":false,"assigneeId":null,"deps":[]}`,
    `  {"type":"update_task","taskId":"","name":null,"trade":null,"startTime":null,"endTime":null,"clearTimes":false}   // clearTimes:true makes it all-day again`,
    `  {"type":"update_contact","contactId":"","name":null,"company":null,"trade":null,"email":null,"phone":null}`,
    `  {"type":"move_task","taskId":"","startDate":"YYYY-MM-DD"}`,
    `  {"type":"shift_task","taskId":"","byDays":0}`,
    `  {"type":"resize_task","taskId":"","durationDays":1}`,
    `  {"type":"assign_task","taskId":"","contactId":""}`,
    `  {"type":"set_status","taskId":"","status":"planned|active|blocked|done"}`,
    `  {"type":"add_dependency","predecessorId":"","successorId":"","depType":"FS","lagDays":0}`,
    `  {"type":"shift_project","projectId":"","byDays":0}`,
    `  {"type":"send_email","contactIds":[""],"subject":"","body":"","taskId":null}`,
    `  {"type":"create_contact","name":"","company":null,"trade":null,"email":null,"phone":null}`,
    `  {"type":"delete_project","projectId":""}      // takes its tasks, links, bookings and calendar events`,
    `  {"type":"delete_task","taskId":""}`,
    `  {"type":"delete_contact","contactId":""}`,
    `  {"type":"unassign_task","taskId":"","contactId":""}     // takes one person off one task`,
    `  {"type":"remove_dependency","predecessorId":"","successorId":""}`,
    "",
    // Every project is listed so a finished or paused one can still be named,
    // renamed or deleted; only the active ones' tasks are carried, which is
    // what keeps this prompt a sensible size.
    "CONTEXT — every project (with its status and total task count), the tasks and dependencies of the ACTIVE ones, and all crew.",
    "For a project whose status is not 'active', call get_project before saying anything about its tasks — they are not below.",
    JSON.stringify({
      projects: ctx.projects,
      tasks: ctx.tasks,
      deps: ctx.deps,
      contacts: ctx.contacts,
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

type Choice = {
  message?: {
    content?: string | null;
    tool_calls?: { id: string; function: { name: string; arguments: string } }[];
  };
};

async function complete(messages: ApiMessage[]): Promise<Choice["message"]> {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${requireEnv("OPENAI_API_KEY")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: getEnv().OPENAI_PLANNER_MODEL,
      temperature: 0.2,
      messages,
      tools: TOOL_DEFINITIONS,
      tool_choice: "auto",
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new AgentError(
      `The assistant did not answer (HTTP ${res.status}). Try again in a moment.` +
        (detail ? ` Detail: ${detail.slice(0, 200)}` : ""),
    );
  }

  const payload = (await res.json()) as { choices?: Choice[] };
  const message = payload.choices?.[0]?.message;
  if (!message) throw new AgentError("The assistant returned an empty response.");
  return message;
}

/**
 * One user turn: think, look things up, and either answer or propose.
 *
 * `history` is whatever the client sent back, so it is untrusted. It cannot do
 * damage — every tool is org-scoped server-side and the only write path
 * re-validates from scratch — but it is capped and re-shaped here rather than
 * passed through as-is.
 */
export async function converse(
  userText: string,
  history: Turn[],
  ctx: PlannerContext,
  orgId: string,
  orgName: string,
): Promise<AgentResult> {
  const turns: Turn[] = [...history.slice(-MAX_HISTORY), { role: "user", content: userText }];

  let proposed: Plan | null = null;
  let reply = "";

  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    const message = await complete([
      { role: "system", content: systemPrompt(ctx, orgName) },
      ...toApiMessages(turns),
    ]);

    const calls = message?.tool_calls ?? [];
    const text = message?.content ?? "";

    if (calls.length === 0) {
      reply = text.trim();
      turns.push({ role: "assistant", content: reply });
      break;
    }

    turns.push({
      role: "assistant",
      content: text,
      toolCalls: calls.map((c) => ({ id: c.id, name: c.function.name, args: c.function.arguments })),
    });

    for (const call of calls) {
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

      if (call.function.name === "propose_changes") {
        // The write path. Validated against the same Zod schema the old
        // one-shot planner used, so a malformed proposal fails here rather
        // than halfway through applying.
        const parsed = planSchema.safeParse({
          summary: args.summary,
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
          // Handed back as a tool result so the model can correct itself,
          // which works far more often than asking the user to rephrase.
          turns.push({
            role: "tool",
            toolCallId: call.id,
            content: JSON.stringify({
              error: `That proposal did not match the schema: ${problems}. Fix it and call propose_changes again.`,
            }),
          });
          continue;
        }

        // Ids are checked here, not trusted from the prompt. An invented id
        // also comes back as a correctable tool error rather than a dead end.
        try {
          proposed = validatePlanIds(parsed.data, ctx);
        } catch (err) {
          turns.push({
            role: "tool",
            toolCallId: call.id,
            content: JSON.stringify({
              error: `${err instanceof Error ? err.message : "Invalid ids."} Use only ids from the context or a tool result, then call propose_changes again.`,
            }),
          });
          continue;
        }
        turns.push({
          role: "tool",
          toolCallId: call.id,
          content: JSON.stringify({
            ok: true,
            note: "Proposal accepted and shown to the user for confirmation. Do not call propose_changes again this turn. Reply with one short line describing it.",
          }),
        });
        continue;
      }

      try {
        const result = await runTool(call.function.name, args, ctx, orgId);
        turns.push({
          role: "tool",
          toolCallId: call.id,
          content: JSON.stringify(result).slice(0, 12_000),
        });
      } catch (err) {
        turns.push({
          role: "tool",
          toolCallId: call.id,
          content: JSON.stringify({
            error: err instanceof Error ? err.message : "That lookup failed.",
          }),
        });
      }
    }
  }

  if (!reply) {
    // Ran out of rounds mid-thought, or answered with tool calls only.
    reply = proposed
      ? "Here's what I'd change — have a look before confirming."
      : "I couldn't work that one out. Try saying it a different way.";
    turns.push({ role: "assistant", content: reply });
  }

  return { reply, plan: proposed, turns: turns.slice(-MAX_HISTORY) };
}
