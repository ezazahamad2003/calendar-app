"use client";

import Link from "next/link";
import { useActionState } from "react";

import { signUp, type FormState } from "../actions";

const EMPTY: FormState = {};

export function SignupForm() {
  const [state, action, pending] = useActionState(signUp, EMPTY);

  return (
    <div className="auth-card">
      <h1 className="auth-title">Create your Foreman account</h1>
      <p className="auth-lede">You&rsquo;ll set up your company on the next screen.</p>

      <form action={action} className="auth-form" noValidate>
        <label className="auth-label" htmlFor="email">
          Email
        </label>
        <input
          className="auth-input"
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          required
          aria-describedby={state.fieldErrors?.email ? "email-error" : undefined}
        />
        {state.fieldErrors?.email ? (
          <p className="auth-field-error" id="email-error">
            {state.fieldErrors.email}
          </p>
        ) : null}

        <label className="auth-label" htmlFor="password">
          Password
        </label>
        <input
          className="auth-input"
          id="password"
          name="password"
          type="password"
          autoComplete="new-password"
          required
          minLength={8}
          aria-describedby="password-hint password-error"
        />
        <p className="auth-hint" id="password-hint">
          At least 8 characters.
        </p>
        {state.fieldErrors?.password ? (
          <p className="auth-field-error" id="password-error">
            {state.fieldErrors.password}
          </p>
        ) : null}

        <button className="auth-submit" type="submit" disabled={pending}>
          {pending ? "Creating account…" : "Create account"}
        </button>
      </form>

      <div aria-live="polite">
        {state.error ? (
          <p className="auth-error" role="alert">
            {state.error}
          </p>
        ) : null}
        {state.notice ? <p className="auth-notice">{state.notice}</p> : null}
      </div>

      <p className="auth-alt">
        Already have an account? <Link href="/login">Sign in</Link>
      </p>
    </div>
  );
}
