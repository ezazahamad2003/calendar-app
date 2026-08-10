"use client";

import Link from "next/link";
import { useActionState, useState } from "react";

import { signIn, sendMagicLink, type FormState } from "../actions";

const EMPTY: FormState = {};

export function LoginForm({ next }: { next: string }) {
  const [mode, setMode] = useState<"password" | "link">("password");

  const [pwState, pwAction, pwPending] = useActionState(signIn, EMPTY);
  const [linkState, linkAction, linkPending] = useActionState(sendMagicLink, EMPTY);

  const state = mode === "password" ? pwState : linkState;
  const pending = mode === "password" ? pwPending : linkPending;

  return (
    <div className="auth-card">
      <h1 className="auth-title">Sign in to Foreman</h1>

      <div className="auth-tabs" role="tablist" aria-label="Sign-in method">
        <button
          type="button"
          role="tab"
          aria-selected={mode === "password"}
          className="auth-tab"
          onClick={() => setMode("password")}
        >
          Password
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === "link"}
          className="auth-tab"
          onClick={() => setMode("link")}
        >
          Email link
        </button>
      </div>

      {mode === "password" ? (
        <form action={pwAction} className="auth-form" noValidate>
          <input type="hidden" name="next" value={next} />

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
            aria-describedby={pwState.fieldErrors?.email ? "email-error" : undefined}
          />
          {pwState.fieldErrors?.email ? (
            <p className="auth-field-error" id="email-error">
              {pwState.fieldErrors.email}
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
            autoComplete="current-password"
            required
            aria-describedby={
              pwState.fieldErrors?.password ? "password-error" : undefined
            }
          />
          {pwState.fieldErrors?.password ? (
            <p className="auth-field-error" id="password-error">
              {pwState.fieldErrors.password}
            </p>
          ) : null}

          <button className="auth-submit" type="submit" disabled={pwPending}>
            {pwPending ? "Signing in…" : "Sign in"}
          </button>
        </form>
      ) : (
        <form action={linkAction} className="auth-form" noValidate>
          <p className="auth-lede">
            We&rsquo;ll email you a link that signs you in. No password needed.
          </p>

          <label className="auth-label" htmlFor="link-email">
            Email
          </label>
          <input
            className="auth-input"
            id="link-email"
            name="email"
            type="email"
            autoComplete="email"
            required
            aria-describedby={
              linkState.fieldErrors?.email ? "link-email-error" : undefined
            }
          />
          {linkState.fieldErrors?.email ? (
            <p className="auth-field-error" id="link-email-error">
              {linkState.fieldErrors.email}
            </p>
          ) : null}

          <button className="auth-submit" type="submit" disabled={linkPending}>
            {linkPending ? "Sending…" : "Email me a link"}
          </button>
        </form>
      )}

      {/* aria-live so the outcome is announced, not just painted. */}
      <div aria-live="polite">
        {state.error ? (
          <p className="auth-error" role="alert">
            {state.error}
          </p>
        ) : null}
        {state.notice ? <p className="auth-notice">{state.notice}</p> : null}
      </div>

      <p className="auth-alt">
        No account yet? <Link href="/signup">Create one</Link>
      </p>

      {/* Reserve the space the pending text occupies so the card does not jump. */}
      <span className="auth-sr" aria-hidden={!pending} />
    </div>
  );
}
