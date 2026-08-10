"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requireUser } from "@/lib/auth/dal";
import { createClient } from "@/lib/supabase/server";
import type { FormState } from "@/app/(auth)/actions";

/**
 * Creates the caller's org. Delegates to `create_org_with_owner()` so the org,
 * the owner membership and the default work calendar land in one transaction —
 * see 20260810130000_create_org_with_owner.sql for why that matters.
 */

const onboardingSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Enter your company name")
    .max(120, "That name is too long — 120 characters maximum"),
  timezone: z
    .string()
    .trim()
    .min(1, "Choose the timezone your jobs run in"),
});

export async function createOrg(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  // Establishes that there is a real session before anything is written. The
  // function re-checks via auth.uid() regardless; this is so the failure is a
  // clean redirect rather than a Postgres exception.
  await requireUser();

  const parsed = onboardingSchema.safeParse({
    name: formData.get("name"),
    timezone: formData.get("timezone"),
  });

  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path[0];
      if (typeof key === "string" && !(key in fieldErrors)) {
        fieldErrors[key] = issue.message;
      }
    }
    return { fieldErrors };
  }

  const supabase = await createClient();
  const { error } = await supabase.rpc("create_org_with_owner", {
    p_name: parsed.data.name,
    p_company_name: parsed.data.name,
    p_timezone: parsed.data.timezone,
  });

  if (error) {
    // A double-submit races two calls; the second hits the one-org-per-user
    // guard. The user's org exists and they should just proceed.
    if (error.code === "23505" || error.message.includes("already belong")) {
      redirect("/");
    }
    return {
      error:
        `Could not create your company: ${error.message}. ` +
        `Nothing was saved — try again.`,
    };
  }

  revalidatePath("/", "layout");
  redirect("/");
}
