import "server-only";

import { getEnv, requireEnv } from "@/lib/env";
import { planSchema } from "./schema";
import type { Plan } from "./schema";
import type { PlannerContext } from "./context";

/**
 * Transcript → Plan, via the planner model in JSON mode (SPEC §5).
 *
 * Plain fetch, no SDK: the OpenAI package is not in the SPEC §1 dependency
 * list, and one POST does not justify adding it.
 *
 * The prompt encodes SPEC §5's planner rules. The two that carry the safety
 * weight: ids must come from the supplied context (validated again in code
 * afterwards — the model saying so is not enough), and ambiguity produces a
 * clarification with zero operations rather than a guess. A sub who gets an
 * email committing his crew to the wrong week is a real cost to a real
 * business.
 */

function systemPrompt(ctx: PlannerContext): string {
  return [
    "You are the scheduling planner for Foreman, a construction scheduling app.",
    "Turn the contractor's request into a JSON plan. You PROPOSE; the user confirms. Never assume execution.",
    "",
    `Today is ${ctx.today} in ${ctx.timezone}. Working days (ISO, 1=Mon..7=Sun): ${ctx.workingDays.join(",")}.`,
    "",
    "Rules:",
    "- Respond with JSON only, matching the schema described below. No prose.",
    "- Every projectId, taskId, contactId MUST be an id from the CONTEXT. Never invent ids.",
    "- EXCEPTION — things created in this same plan are referenced by temp id, positional on the operation's index in the operations array: create_project at index 0 is \"$p0\", create_task at index 2 is \"$t2\", create_contact at index 1 is \"$c1\". A later operation may reference an earlier one's temp id; never a later one's.",
    "- create_project when the user asks to start/make/create/set up a job, project or site that is NOT already in CONTEXT. Then put its tasks in it with create_task using the project's \"$pN\".",
    "- Only set create_project.color when the user names a colour out loud ('make it blue'). Otherwise leave it null and the app colours it. Valid values are #rrggbb only.",
    "- An empty CONTEXT projects list is normal for a new account. Do not refuse for lack of a project — create one.",
    "- Fuzzy-match names generously: people, tasks and projects by name, trade or company. Spoken words arrive mangled ('chico' may be a project named Chico Flats).",
    "- `clarification` is ONLY for things you cannot safely guess: which of two people or projects was meant, or a missing email address. Setting it cancels the entire request, so use it only when proceeding could do the wrong thing.",
    "- `notes` is for parts of the request you could not carry out while still doing the rest. Do the work, then say what you dropped. Never use `clarification` for this.",
    "- Foreman schedules whole days, never times of day. A request like 'from 8 to 10pm' or 'add Alex 8-12' becomes an ordinary day-level task; put the dropped times in `notes`. This is a note, NOT a clarification — still return the operations.",
    "- Same for anything else outside the model (costs, weather, equipment, hours worked): schedule what you can and note the rest.",
    "- If a name could match two different entities, set `clarification` naming both candidates and return operations: [].",
    "- If the request references a person or project not in context, set `clarification` and return operations: []. But if they asked to CREATE it, create it instead — that is not ambiguity.",
    "- Never guess an email address. To email a contact whose hasEmail is false, set `clarification` asking for their address, operations: [].",
    "- Prefer shift_task/shift_project (relative work days) when the user speaks relatively ('push back two weeks' = byDays: 10 on a 5-day week). Use move_task only for explicit dates. The app does all date arithmetic — you never compute calendar dates yourself.",
    "- 'two weeks' means 10 work days on a 5-day calendar; scale by the working-day count.",
    "- New tasks that must follow an existing task go in create_task.deps.",
    "- send_email is the ONLY way to notify, tell, or update a person. 'Let Tom know' = send_email to Tom (if he has an email) with a body explaining the change. There is no 'notify' operation.",
    "- The type field must be exactly one of the eleven values below. Any other value is invalid.",
    "- send_email: write a short, plain, professional body a contractor would send. Sign off with the company name only.",
    "- confidence: 'low' whenever you fuzzy-matched anything important or the transcript was garbled; 'high' only when every reference was unambiguous.",
    "",
    "Plan schema:",
    `{"summary": "one sentence read back to the user",`,
    ` "operations": [`,
    `  {"type":"create_project","name":"","clientName":null,"address":null,"jobNumber":null,"startsOn":"YYYY-MM-DD or null","color":null},`,
    `  {"type":"create_task","projectId":"","name":"","trade":null,"startDate":"YYYY-MM-DD or null","durationDays":1,"isMilestone":false,"assigneeId":null,"deps":[]},`,
    `  {"type":"move_task","taskId":"","startDate":"YYYY-MM-DD"},`,
    `  {"type":"shift_task","taskId":"","byDays":0},`,
    `  {"type":"resize_task","taskId":"","durationDays":1},`,
    `  {"type":"assign_task","taskId":"","contactId":""},`,
    `  {"type":"set_status","taskId":"","status":"planned|active|blocked|done"},`,
    `  {"type":"add_dependency","predecessorId":"","successorId":"","depType":"FS","lagDays":0},`,
    `  {"type":"shift_project","projectId":"","byDays":0},`,
    `  {"type":"send_email","contactIds":[""],"subject":"","body":"","taskId":null},`,
    `  {"type":"create_contact","name":"","company":null,"trade":null,"email":null,"phone":null}`,
    ` ],`,
    ` "clarification": "blocks everything; set ONLY when you cannot safely guess, and then operations must be []",`,
    ` "notes": "what you could not do, having done the rest; does not block",`,
    ` "confidence": "high|low"}`,
    "",
    "CONTEXT:",
    JSON.stringify({
      projects: ctx.projects,
      tasks: ctx.tasks,
      deps: ctx.deps,
      contacts: ctx.contacts,
    }),
  ].join("\n");
}

export class PlannerError extends Error {}

type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

async function completeJson(messages: ChatMessage[]): Promise<string> {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${requireEnv("OPENAI_API_KEY")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: getEnv().OPENAI_PLANNER_MODEL,
      response_format: { type: "json_object" },
      temperature: 0.2,
      messages,
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new PlannerError(
      `The planner did not answer (HTTP ${res.status}). Try again in a moment.` +
        (detail ? ` Detail: ${detail.slice(0, 200)}` : ""),
    );
  }

  const payload: unknown = await res.json();
  const content = (payload as { choices?: { message?: { content?: string } }[] })
    ?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || content.trim() === "") {
    throw new PlannerError("The planner returned an empty response. Try again.");
  }
  return content;
}

export async function planFromTranscript(
  transcript: string,
  ctx: PlannerContext,
): Promise<Plan> {
  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt(ctx) },
    { role: "user", content: transcript },
  ];

  // One self-correcting retry: models occasionally invent an operation type or
  // drop a required field, and feeding the validation error back fixes it far
  // more often than asking the contractor to rephrase.
  let plan: Plan | null = null;
  for (let attempt = 0; attempt < 2 && !plan; attempt += 1) {
    const content = await completeJson(messages);

    let raw: unknown;
    try {
      raw = JSON.parse(content);
    } catch {
      throw new PlannerError("The planner returned malformed JSON. Try again.");
    }

    const parsed = planSchema.safeParse(raw);
    if (parsed.success) {
      plan = parsed.data;
      break;
    }

    const problems = parsed.error.issues
      .slice(0, 3)
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    if (attempt === 1) {
      throw new PlannerError(
        `The planner's response did not match the expected shape: ${problems}. Try rephrasing.`,
      );
    }
    messages.push(
      { role: "assistant", content },
      {
        role: "user",
        content:
          `That response was invalid: ${problems}. Reply again with ONLY valid ` +
          `JSON matching the schema. The "type" of every operation must be one ` +
          `of the ten documented values.`,
      },
    );
  }
  if (!plan) throw new PlannerError("The planner could not produce a plan. Try again.");

  // A clarification with operations attached is a contradiction — the model
  // hedged. Treat it as a pure clarification rather than half-executing.
  if (plan.clarification && plan.operations.length > 0) {
    return { ...plan, operations: [] };
  }

  // ── Hard id validation (SPEC §5): hallucinated id = failure, not skip ─────
  const projectIds = new Set(ctx.projects.map((p) => p.id));
  const taskIds = new Set(ctx.tasks.map((t) => t.id));
  const contactIds = new Set(ctx.contacts.map((c) => c.id));
  // Temp ids for rows created earlier in this same plan. Populated as the loop
  // walks forward, which is what makes a backward reference legal and a
  // forward one ("assign to $c3" from index 1) fail — the batch inserts in
  // order, so a forward reference would resolve to nothing at apply time.
  const tempIds = new Set<string>();

  const badId = (kind: string, value: string) =>
    new PlannerError(
      `The planner referenced a ${kind} that does not exist (${value}). ` +
        `Nothing was changed — try rephrasing.`,
    );

  plan.operations.forEach((op, index) => {
    const knownTask = (v: string) => taskIds.has(v) || tempIds.has(v);
    const knownContact = (v: string) => contactIds.has(v) || tempIds.has(v);
    const knownProject = (v: string) => projectIds.has(v) || tempIds.has(v);
    switch (op.type) {
      case "create_project":
        tempIds.add(`$p${index}`);
        break;
      case "create_task": {
        if (!knownProject(op.projectId)) throw badId("project", op.projectId);
        if (op.assigneeId && !knownContact(op.assigneeId))
          throw badId("contact", op.assigneeId);
        for (const d of op.deps) if (!knownTask(d)) throw badId("task", d);
        tempIds.add(`$t${index}`);
        break;
      }
      case "move_task":
      case "shift_task":
      case "resize_task":
      case "set_status":
        if (!knownTask(op.taskId)) throw badId("task", op.taskId);
        break;
      case "assign_task":
        if (!knownTask(op.taskId)) throw badId("task", op.taskId);
        if (!knownContact(op.contactId)) throw badId("contact", op.contactId);
        break;
      case "add_dependency":
        if (!knownTask(op.predecessorId)) throw badId("task", op.predecessorId);
        if (!knownTask(op.successorId)) throw badId("task", op.successorId);
        break;
      case "shift_project":
        // A project created in this same plan has nothing to shift.
        if (!projectIds.has(op.projectId)) throw badId("project", op.projectId);
        break;
      case "send_email": {
        for (const c of op.contactIds) {
          if (!knownContact(c)) throw badId("contact", c);
          const contact = ctx.contacts.find((x) => x.id === c);
          // Belt and braces: the prompt forbids this, and the code refuses it.
          // A contact created in this same plan has no row to check yet, so it
          // is judged on the address the plan itself supplies.
          if (contact && !contact.hasEmail) {
            throw new PlannerError(
              `${contact.name} has no email address on file. Add one on the ` +
                `Crew page first — Foreman never guesses an address.`,
            );
          }
        }
        if (op.taskId && !knownTask(op.taskId)) throw badId("task", op.taskId);
        break;
      }
      case "create_contact":
        tempIds.add(`$c${index}`);
        break;
    }
  });

  return plan;
}
