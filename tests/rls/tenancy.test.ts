import { randomUUID } from "node:crypto";
import {
  createClient,
  type PostgrestSingleResponse,
  type SupabaseClient,
} from "@supabase/supabase-js";
import { beforeAll, describe, expect, it } from "vitest";
import type { Database } from "../../src/lib/database.types";
import { localStack } from "./local-stack";

/**
 * Phase 1 gate (SPEC §9): org A cannot read org B, and `provider_connections` is
 * unreadable from the client role.
 *
 * These tests are deliberately adversarial. A tenancy test that only proves the
 * happy path — "user A can see user A's data" — passes just as happily against
 * a database with RLS switched off entirely. Every isolation assertion below is
 * therefore paired with a service-role read proving the hidden row *does*
 * exist, so "zero rows" means "blocked", not "nothing was there".
 */

type OrgFixture = {
  label: string;
  orgId: string;
  userId: string;
  projectId: string;
  taskId: string;
  contactId: string;
  /** Signed in as this org's member, holding the publishable/anon key. */
  client: SupabaseClient<Database>;
};

/** Bypasses RLS. Seeds fixtures and verifies what the client role cannot see. */
let admin: SupabaseClient<Database>;
let orgA: OrgFixture;
let orgB: OrgFixture;

/** Distinguishes rows between runs — teardown cannot delete orgs (see below). */
const runId = randomUUID().slice(0, 8);

/**
 * Unwrap a PostgREST result or throw with a message naming the failed step.
 * Keeps the call sites free of `!` (SPEC §8).
 *
 * Typed against PostgREST's own `PostgrestSingleResponse` rather than a
 * hand-rolled `{ data, error }` shape. That response is a discriminated union,
 * and any structural approximation of it makes TypeScript infer `T` from the
 * failure branch too — collapsing it to `never` and breaking every field access
 * at the call sites. List responses are covered as well, since postgrest-js
 * defines `PostgrestResponse<T>` as `PostgrestSingleResponse<T[]>`.
 */
function unwrap<T>(result: PostgrestSingleResponse<T>, what: string): NonNullable<T> {
  if (result.error) throw new Error(`${what} failed: ${result.error.message}`);
  const data = result.data;
  if (data === null || data === undefined) throw new Error(`${what} returned no data`);
  return data;
}

async function seedOrg(label: string): Promise<OrgFixture> {
  const org = unwrap(
    await admin
      .from("orgs")
      .insert({ name: `${label} Construction ${runId}`, timezone: "America/Los_Angeles" })
      .select("id")
      .single(),
    `create org ${label}`,
  );

  const email = `foreman-${label.toLowerCase()}-${runId}@example.com`;
  const password = `pw-${randomUUID()}`;

  const created = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (created.error) throw new Error(`create user ${label} failed: ${created.error.message}`);
  const userId = created.data.user.id;

  unwrap(
    await admin
      .from("memberships")
      .insert({ org_id: org.id, user_id: userId, role: "owner" })
      .select("id")
      .single(),
    `create membership ${label}`,
  );

  const project = unwrap(
    await admin
      .from("projects")
      .insert({ org_id: org.id, name: `${label} Hillcrest`, job_number: `JOB-${label}` })
      .select("id")
      .single(),
    `create project ${label}`,
  );

  const task = unwrap(
    await admin
      .from("tasks")
      .insert({
        org_id: org.id,
        project_id: project.id,
        name: `${label} Framing`,
        trade: "Framing",
        start_date: "2026-03-03",
        duration_days: 10,
      })
      .select("id")
      .single(),
    `create task ${label}`,
  );

  const contact = unwrap(
    await admin
      .from("contacts")
      .insert({
        org_id: org.id,
        name: `${label} Tom`,
        company: `${label} Northstate Framing`,
        trade: "Framing",
        email: `tom-${label.toLowerCase()}-${runId}@example.com`,
      })
      .select("id")
      .single(),
    `create contact ${label}`,
  );

  // Seeded so the "client sees zero rows" assertion is meaningful rather than
  // vacuously true. This is a fake token; the real column holds AES-256-GCM
  // ciphertext (SPEC §3).
  unwrap(
    await admin
      .from("provider_connections")
      .insert({
        org_id: org.id,
        user_id: userId,
        provider: "microsoft",
        provider_user_id: `ms-${label}-${runId}`,
        email,
        refresh_token_encrypted: `ciphertext-for-${label}-${runId}`,
        scopes: ["Mail.Send", "Calendars.ReadWrite"],
      })
      .select("id")
      .single(),
    `create provider_connection ${label}`,
  );

  unwrap(
    await admin
      .from("change_log")
      .insert({
        org_id: org.id,
        actor_user_id: userId,
        entity_type: "task",
        entity_id: task.id,
        action: "create",
        after: { name: `${label} Framing` },
        source: "system",
      })
      .select("id")
      .single(),
    `create change_log ${label}`,
  );

  const stack = localStack();
  const client = createClient<Database>(stack.apiUrl, stack.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const signIn = await client.auth.signInWithPassword({ email, password });
  if (signIn.error) throw new Error(`sign in ${label} failed: ${signIn.error.message}`);

  return {
    label,
    orgId: org.id,
    userId,
    projectId: project.id,
    taskId: task.id,
    contactId: contact.id,
    client,
  };
}

beforeAll(async () => {
  const stack = localStack();
  admin = createClient<Database>(stack.apiUrl, stack.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Sequential: two orgs, so parallelism buys nothing and ordering aids debugging.
  orgA = await seedOrg("A");
  orgB = await seedOrg("B");
}, 60_000);

describe("tenant isolation — org A cannot reach org B", () => {
  it("sees its own project and nothing else", async () => {
    const { data, error } = await orgA.client.from("projects").select("id, org_id");

    expect(error).toBeNull();
    expect(data).toHaveLength(1);
    expect(data?.[0]?.id).toBe(orgA.projectId);

    // Both orgs' projects exist; only one is visible.
    const all = unwrap(await admin.from("projects").select("id"), "admin read projects");
    expect(all.length).toBeGreaterThanOrEqual(2);
  });

  it("returns zero rows when org A asks for org B's project by id", async () => {
    const { data, error } = await orgA.client
      .from("projects")
      .select("id")
      .eq("id", orgB.projectId);
    expect(error).toBeNull();
    expect(data).toEqual([]);

    // The row is really there — the client just cannot see it.
    const asAdmin = unwrap(
      await admin.from("projects").select("id").eq("id", orgB.projectId),
      "admin read projects",
    );
    expect(asAdmin).toHaveLength(1);
  });

  it("returns zero rows when org A asks for org B's task by id", async () => {
    const { data, error } = await orgA.client.from("tasks").select("id").eq("id", orgB.taskId);
    expect(error).toBeNull();
    expect(data).toEqual([]);

    const asAdmin = unwrap(
      await admin.from("tasks").select("id").eq("id", orgB.taskId),
      "admin read tasks",
    );
    expect(asAdmin).toHaveLength(1);
  });

  it("returns zero rows when org A asks for org B's contact by id", async () => {
    const { data, error } = await orgA.client
      .from("contacts")
      .select("id")
      .eq("id", orgB.contactId);
    expect(error).toBeNull();
    expect(data).toEqual([]);

    const asAdmin = unwrap(
      await admin.from("contacts").select("id").eq("id", orgB.contactId),
      "admin read contacts",
    );
    expect(asAdmin).toHaveLength(1);
  });

  it("cannot widen its view by filtering on org B's id", async () => {
    const { data, error } = await orgA.client
      .from("tasks")
      .select("id, org_id")
      .eq("org_id", orgB.orgId);

    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it("cannot insert a row into org B", async () => {
    const { error } = await orgA.client
      .from("projects")
      .insert({ org_id: orgB.orgId, name: "planted by org A" });

    expect(error).not.toBeNull();
    expect(error?.code).toBe("42501"); // insufficient_privilege — RLS WITH CHECK
  });

  it("cannot update org B's task", async () => {
    const { data, error } = await orgA.client
      .from("tasks")
      .update({ name: "hijacked" })
      .eq("id", orgB.taskId)
      .select("id");

    expect(error).toBeNull();
    expect(data).toEqual([]); // filtered out by USING, so nothing was updated

    const after = unwrap(
      await admin.from("tasks").select("name").eq("id", orgB.taskId).single(),
      "admin re-read org B task",
    );
    expect(after.name).toBe("B Framing");
  });

  it("cannot delete org B's task", async () => {
    const { error } = await orgA.client.from("tasks").delete().eq("id", orgB.taskId);
    expect(error).toBeNull();

    const survivors = unwrap(
      await admin.from("tasks").select("id").eq("id", orgB.taskId),
      "admin re-read org B task",
    );
    expect(survivors).toHaveLength(1);
  });

  it("gives auth_org_ids() only the caller's orgs", async () => {
    const { data, error } = await orgA.client.rpc("auth_org_ids");

    expect(error).toBeNull();
    expect(data).toEqual([orgA.orgId]);
  });

  it("shows a signed-out client nothing at all", async () => {
    const stack = localStack();
    const anon = createClient<Database>(stack.apiUrl, stack.anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    expect((await anon.from("orgs").select("id")).data ?? [], "orgs").toEqual([]);
    expect((await anon.from("projects").select("id")).data ?? [], "projects").toEqual([]);
    expect((await anon.from("tasks").select("id")).data ?? [], "tasks").toEqual([]);
    expect((await anon.from("contacts").select("id")).data ?? [], "contacts").toEqual([]);
    expect((await anon.from("memberships").select("id")).data ?? [], "memberships").toEqual([]);
  });
});

describe("provider_connections is invisible to the client role", () => {
  it("has rows that the service role can see", async () => {
    const rows = unwrap(
      await admin.from("provider_connections").select("id, refresh_token_encrypted"),
      "admin read provider_connections",
    );
    expect(rows.length).toBeGreaterThanOrEqual(2);
  });

  it("returns nothing to a signed-in member of the owning org", async () => {
    const { data, error } = await orgA.client.from("provider_connections").select("*");

    // RLS is enabled with no policies AND the grants are revoked, so this is
    // either a permission error or an empty set. Never a token.
    expect(data ?? []).toEqual([]);
    if (error) expect(error.code).toBe("42501");
  });

  it("refuses a targeted read of a known connection id", async () => {
    const known = unwrap(
      await admin.from("provider_connections").select("id").eq("org_id", orgA.orgId).single(),
      "admin read org A connection",
    );

    const { data } = await orgA.client
      .from("provider_connections")
      .select("refresh_token_encrypted")
      .eq("id", known.id);

    expect(data ?? []).toEqual([]);
  });

  it("refuses a client-side write", async () => {
    const { error } = await orgA.client
      .from("provider_connections")
      .update({ status: "needs_reauth" })
      .eq("org_id", orgA.orgId);

    expect(error).not.toBeNull();
  });
});

describe("change_log is append-only", () => {
  it("lets a member read and append their org's entries", async () => {
    const read = await orgA.client.from("change_log").select("id, org_id");
    expect(read.error).toBeNull();
    expect(read.data).toHaveLength(1);

    const { error } = await orgA.client.from("change_log").insert({
      org_id: orgA.orgId,
      actor_user_id: orgA.userId,
      entity_type: "task",
      entity_id: orgA.taskId,
      action: "move",
      source: "voice",
      transcript: "push framing back two weeks",
    });
    expect(error).toBeNull();
  });

  it("rejects an update even from the service role", async () => {
    const { error } = await admin
      .from("change_log")
      .update({ action: "rewritten" })
      .eq("org_id", orgA.orgId);

    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/append-only/i);
  });

  it("rejects a delete even from the service role", async () => {
    const { error } = await admin.from("change_log").delete().eq("org_id", orgA.orgId);

    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/append-only/i);
  });

  it("blocks deleting an org, because that would cascade into the audit trail", async () => {
    // Documented consequence of the append-only trigger, asserted so it is a
    // known property rather than a surprise the first time someone tries it.
    const { error } = await admin.from("orgs").delete().eq("id", orgA.orgId);

    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/append-only/i);
  });
});

describe("cross-org rows cannot be stitched together", () => {
  it("refuses a dependency whose two tasks live in different orgs", async () => {
    // Service role, so RLS is not involved — this is the composite foreign key
    // doing the work.
    const { error } = await admin.from("task_deps").insert({
      org_id: orgA.orgId,
      predecessor_id: orgA.taskId,
      successor_id: orgB.taskId,
      dep_type: "FS",
    });

    expect(error).not.toBeNull();
    expect(error?.code).toBe("23503"); // foreign_key_violation
  });

  it("refuses an assignment pairing org A's task with org B's contact", async () => {
    const { error } = await admin.from("assignments").insert({
      org_id: orgA.orgId,
      task_id: orgA.taskId,
      contact_id: orgB.contactId,
    });

    expect(error).not.toBeNull();
    expect(error?.code).toBe("23503");
  });

  it("refuses a task pointing at another org's project", async () => {
    const { error } = await admin.from("tasks").insert({
      org_id: orgA.orgId,
      project_id: orgB.projectId,
      name: "smuggled",
    });

    expect(error).not.toBeNull();
    expect(error?.code).toBe("23503");
  });

  it("keeps a sent message when its task is deleted, without nulling org_id", async () => {
    // Regression guard: a plain ON DELETE SET NULL on the composite key would
    // null org_id too and fail the not-null constraint, making tasks with any
    // outbound message undeletable.
    const project = unwrap(
      await admin
        .from("projects")
        .insert({ org_id: orgA.orgId, name: `Teardown ${runId}` })
        .select("id")
        .single(),
      "create teardown project",
    );
    const task = unwrap(
      await admin
        .from("tasks")
        .insert({ org_id: orgA.orgId, project_id: project.id, name: "Doomed" })
        .select("id")
        .single(),
      "create doomed task",
    );
    const message = unwrap(
      await admin
        .from("outbound_messages")
        .insert({
          org_id: orgA.orgId,
          task_id: task.id,
          channel: "email",
          subject: "Framing moved",
          status: "sent",
          idempotency_key: `key-${randomUUID()}`,
        })
        .select("id")
        .single(),
      "create outbound message",
    );

    const deleted = await admin.from("tasks").delete().eq("id", task.id);
    expect(deleted.error).toBeNull();

    const surviving = unwrap(
      await admin
        .from("outbound_messages")
        .select("id, org_id, task_id")
        .eq("id", message.id)
        .single(),
      "re-read outbound message",
    );
    expect(surviving.task_id).toBeNull();
    expect(surviving.org_id).toBe(orgA.orgId);
  });

  it("refuses a self-referencing dependency", async () => {
    const { error } = await admin.from("task_deps").insert({
      org_id: orgA.orgId,
      predecessor_id: orgA.taskId,
      successor_id: orgA.taskId,
    });

    expect(error).not.toBeNull();
    expect(error?.code).toBe("23514"); // check_violation
  });
});
