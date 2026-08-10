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
    "- Fuzzy-match names generously: people, tasks and projects by name, trade or company. Spoken words arrive mangled ('chico' may be a project named Chico Flats).",
    "- If a name could match two different entities, set `clarification` naming both candidates and return operations: [].",
    "- If the request references a person or project not in context, set `clarification` and return operations: [].",
    "- Never guess an email address. To email a contact whose hasEmail is false, set `clarification` asking for their address, operations: [].",
    "- Prefer shift_task/shift_project (relative work days) when the user speaks relatively ('push back two weeks' = byDays: 10 on a 5-day week). Use move_task only for explicit dates. The app does all date arithmetic — you never compute calendar dates yourself.",
    "- 'two weeks' means 10 work days on a 5-day calendar; scale by the working-day count.",
    "- New tasks that must follow an existing task go in create_task.deps.",
    "- send_email is the ONLY way to notify, tell, or update a person. 'Let Tom know' = send_email to Tom (if he has an email) with a body explaining the change. There is no 'notify' operation.",
    "- The type field must be exactly one of the ten values below. Any other value is invalid.",
    "- send_email: write a short, plain, professional body a contractor would send. Sign off with the company name only.",
    "- confidence: 'low' whenever you fuzzy-matched anything important or the transcript was garbled; 'high' only when every reference was unambiguous.",
    "",
    "Plan schema:",
    `{"summary": "one sentence read back to the user",`,
    ` "operations": [`,
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
    ` "clarification": "set ONLY when ambiguous; then operations must be []",`,
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
  const tempIds = new Set<string>();

  const badId = (kind: string, value: string) =>
    new PlannerError(
      `The planner referenced a ${kind} that does not exist (${value}). ` +
        `Nothing was changed — try rephrasing.`,
    );

  plan.operations.forEach((op, index) => {
    const knownTask = (v: string) => taskIds.has(v) || tempIds.has(v);
    switch (op.type) {
      case "create_task": {
        if (!projectIds.has(op.projectId)) throw badId("project", op.projectId);
        if (op.assigneeId && !contactIds.has(op.assigneeId))
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
        if (!contactIds.has(op.contactId)) throw badId("contact", op.contactId);
        break;
      case "add_dependency":
        if (!knownTask(op.predecessorId)) throw badId("task", op.predecessorId);
        if (!knownTask(op.successorId)) throw badId("task", op.successorId);
        break;
      case "shift_project":
        if (!projectIds.has(op.projectId)) throw badId("project", op.projectId);
        break;
      case "send_email": {
        for (const c of op.contactIds) {
          if (!contactIds.has(c)) throw badId("contact", c);
          const contact = ctx.contacts.find((x) => x.id === c);
          // Belt and braces: the prompt forbids this, and the code refuses it.
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
        break;
    }
  });

  return plan;
}
