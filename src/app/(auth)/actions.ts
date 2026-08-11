"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { createClient } from "@/lib/supabase/server";
import { getAppOrigin } from "@/lib/app-url";

/**
 * Auth server actions. Every one of these validates its input with Zod before
 * it reaches Supabase (SPEC §8) and returns a `FormState` the page can render —
 * never a bare "Error" toast.
 */

export type FormState = {
  error?: string;
  /** Field-level messages, keyed by input name. */
  fieldErrors?: Record<string, string>;
  /** Set on success where there is no redirect, e.g. "check your email". */
  notice?: string;
};

/**
 * Supabase rejects weak passwords server-side, but doing it here too means the
 * user finds out before a round trip, and the message names the actual rule.
 */
const passwordSchema = z
  .string()
  .min(8, "Password must be at least 8 characters");

const credentialsSchema = z.object({
  email: z.email("Enter a valid email address"),
  password: passwordSchema,
});

const emailOnlySchema = z.object({
  email: z.email("Enter a valid email address"),
});

/** Collapse a ZodError into per-field messages for the form to render. */
function fieldErrorsFrom(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path[0];
    if (typeof key === "string" && !(key in out)) out[key] = issue.message;
  }
  return out;
}

/**
 * Only relative, single-slash paths. Without this check, `?next=` is an open
 * redirect: a link to our own login page could bounce a signed-in contractor
 * to an attacker's lookalike.
 */
function safeNext(next: FormData | string | null): string {
  const raw = typeof next === "string" ? next : null;
  // `/` is the marketing page. Someone who has just typed their password does
  // not want to read about the product, so signing in always lands on the
  // schedule unless they were headed somewhere more specific.
  if (!raw || raw === "/") return "/calendar";
  if (!raw.startsWith("/") || raw.startsWith("//")) return "/calendar";
  return raw;
}

export async function signIn(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = credentialsSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
  });
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error) };

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword(parsed.data);

  if (error) {
    // Supabase returns the same generic message for "no such user" and "wrong
    // password" on purpose — echoing anything more specific would turn this
    // form into an account-enumeration oracle.
    return {
      error:
        error.message === "Invalid login credentials"
          ? "That email and password don't match an account. Check both, or sign up."
          : `Could not sign you in: ${error.message}`,
    };
  }

  revalidatePath("/", "layout");
  redirect(safeNext(formData.get("next") as string | null));
}

export async function signUp(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = credentialsSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
  });
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error) };

  const supabase = await createClient();
  const { data, error } = await supabase.auth.signUp({
    ...parsed.data,
    options: {
      emailRedirectTo: `${getAppOrigin()}/auth/callback`,
    },
  });

  if (error) return { error: `Could not create your account: ${error.message}` };

  // With email confirmation enabled, signUp returns a user but no session. The
  // user has to click the link before they have one, so there is nothing to
  // redirect to yet.
  if (!data.session) {
    return {
      notice:
        `Check ${parsed.data.email} for a confirmation link. ` +
        `You'll set up your company after you confirm.`,
    };
  }

  revalidatePath("/", "layout");
  redirect("/onboarding");
}

export async function sendMagicLink(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = emailOnlySchema.safeParse({ email: formData.get("email") });
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error) };

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithOtp({
    email: parsed.data.email,
    options: {
      emailRedirectTo: `${getAppOrigin()}/auth/callback`,
    },
  });

  if (error) return { error: `Could not send the link: ${error.message}` };

  return {
    notice: `Link sent to ${parsed.data.email}. It expires in an hour.`,
  };
}

export async function signOut(): Promise<void> {
  const supabase = await createClient();
  await supabase.auth.signOut();
  revalidatePath("/", "layout");
  redirect("/login");
}
