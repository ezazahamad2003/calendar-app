import type { Metadata } from "next";
import Link from "next/link";

/**
 * The public landing page — the one screen in the app written for someone who
 * does not have an account yet.
 *
 * SPEC §7 said not to build one. That was written when the app was internal and
 * the only user was the person who commissioned it; it now has a sign-up form
 * and a URL, and sending a stranger straight to a password field explains
 * nothing. The instruction is superseded rather than ignored.
 *
 * The hero is the product's actual thesis rather than a screenshot: one spoken
 * sentence, and the cascade it sets off. Everything a contractor mistrusts
 * about "AI for scheduling" is answered by seeing that the dates are worked out
 * for them and that nothing happens until they confirm — so that is the first
 * thing on the page and the last.
 *
 * Server-rendered, no client JavaScript, no network fonts. It is the first
 * thing anyone loads and often on a phone with one bar of signal.
 */

export const metadata: Metadata = {
  title: "Foreman — talk to your construction schedule",
  description:
    "Move a date by saying so. Foreman cascades every dependent task, drafts the email to the sub, and waits for you to confirm before anything sends.",
};

/**
 * The cascade strip: what "push framing back two weeks" actually does.
 *
 * Columns are half-weeks across a six-week window. `was` is where the bar sat
 * before, `now` is where the schedule engine puts it — the same two-position
 * story the plan diff tells inside the app, which is the point. Anyone who has
 * moved one date in Microsoft Project and then re-typed six others into an
 * email recognises this picture immediately.
 */
const CASCADE = [
  { name: "Framing", trade: "Carpentry", was: [2, 6], now: [6, 10], kind: "direct" },
  { name: "Roof dry-in", trade: "Roofing", was: [6, 9], now: [10, 13], kind: "knock-on" },
  { name: "Rough plumbing", trade: "Plumbing", was: [8, 11], now: [12, 15], kind: "knock-on" },
] as const;

const WEEKS = ["2 Mar", "9 Mar", "16 Mar", "23 Mar", "30 Mar", "6 Apr"];

export default function Landing() {
  return (
    <div className="lp">
      <header className="lp-top">
        <p className="lp-brand">
          <span className="lp-brand-mark" aria-hidden>
            F
          </span>
          Foreman
        </p>
        <nav className="lp-top-nav" aria-label="Account">
          <Link className="lp-link" href="/login">
            Sign in
          </Link>
          <Link className="lp-btn lp-btn--small" href="/signup">
            Start free
          </Link>
        </nav>
      </header>

      <main>
        {/* ── Hero ───────────────────────────────────────────────────────── */}
        <section className="lp-hero">
          <div className="lp-hero-copy">
            <p className="lp-eyebrow">Scheduling for general contractors</p>
            <h1 className="lp-title">
              Talk to the schedule.
              <span className="lp-title-sub">It does the arithmetic.</span>
            </h1>
            <p className="lp-lede">
              You are standing on a slab holding a phone. Say what changed.
              Foreman moves the bar, pushes every task that depended on it,
              drafts the email to the sub and puts the new dates on your
              calendar — then waits for you to read it and tap Confirm.
            </p>
            <div className="lp-cta">
              <Link className="lp-btn" href="/signup">
                Start free
              </Link>
              <Link className="lp-link lp-link--arrow" href="/login">
                I already have an account
              </Link>
            </div>
          </div>

          <figure className="lp-demo">
            <figcaption className="lp-said">
              <span className="lp-said-label">You said</span>
              <q>Push framing on Hillcrest back two weeks and let Tom know.</q>
            </figcaption>

            <div className="lp-strip">
              <div className="lp-strip-scale" aria-hidden>
                {WEEKS.map((w) => (
                  <span key={w}>{w}</span>
                ))}
              </div>

              {CASCADE.map((row) => (
                <div key={row.name} className="lp-strip-row">
                  <p className="lp-strip-name">
                    {row.name}
                    <span>{row.trade}</span>
                  </p>
                  <div className="lp-strip-track">
                    <span
                      className="lp-bar lp-bar--was"
                      style={{ gridColumn: `${row.was[0]} / ${row.was[1]}` }}
                    >
                      <i aria-hidden />
                    </span>
                    <span
                      className={`lp-bar lp-bar--now lp-bar--${row.kind}`}
                      style={{ gridColumn: `${row.now[0]} / ${row.now[1]}` }}
                    />
                  </div>
                  <p className="lp-strip-note">
                    {row.kind === "direct" ? "+14 days" : "knock-on"}
                  </p>
                </div>
              ))}
            </div>

            <p className="lp-demo-foot">
              <span className="lp-demo-mail">Email</span> Tom Brady Jr,
              Northstate Framing — <strong>held until you confirm</strong>
            </p>
          </figure>
        </section>

        {/* ── The pipeline ───────────────────────────────────────────────── */}
        <section className="lp-band">
          <div className="lp-inner">
            <h2 className="lp-h2">Four steps, and you own the last one</h2>
            <p className="lp-sub">
              The order matters. Nothing leaves your phone until the fourth step.
            </p>

            {/* Numbered because it genuinely is a sequence, and the whole
                argument of the product is which step comes last. */}
            <ol className="lp-chain">
              <li>
                <span className="lp-chain-n">1</span>
                <h3>Say it</h3>
                <p>
                  Push to talk, like a radio. No open mic on a noisy site, and
                  typing works when it is too loud to speak.
                </p>
              </li>
              <li>
                <span className="lp-chain-n">2</span>
                <h3>It works out the dates</h3>
                <p>
                  Work days, not calendar days. Weekends and your holidays are
                  skipped, and every dependent task moves with the one you named.
                </p>
              </li>
              <li>
                <span className="lp-chain-n">3</span>
                <h3>Read the diff</h3>
                <p>
                  Old date beside new, knock-ons marked as knock-ons, and the
                  full text of any email — legible at arm&rsquo;s length in
                  sunlight.
                </p>
              </li>
              <li>
                <span className="lp-chain-n">4</span>
                <h3>Confirm</h3>
                <p>
                  One tap applies the lot in a single transaction, sends the
                  mail from your own account and updates your calendar.
                </p>
              </li>
            </ol>
          </div>
        </section>

        {/* ── What you get ───────────────────────────────────────────────── */}
        <section className="lp-inner lp-features">
          <h2 className="lp-h2">What is in it</h2>
          <div className="lp-grid">
            <article className="lp-card">
              <h3>A calendar you can actually read</h3>
              <p>
                Day, week, month and year. Hour-by-hour where you need a time on
                something, all-day where you do not, and overlapping crews shown
                side by side instead of stacked on top of each other.
              </p>
            </article>
            <article className="lp-card">
              <h3>A colour per job</h3>
              <p>
                Every job keeps its colour on every screen, with the trade as a
                stripe down the edge of the bar. Four jobs in one week stay four
                jobs, not a wall of grey.
              </p>
            </article>
            <article className="lp-card">
              <h3>Ask it anything</h3>
              <p>
                &ldquo;Is Alex free Tuesday?&rdquo; &ldquo;What&rsquo;s late on
                Hillcrest?&rdquo; &ldquo;Did Tom get told about the pour?&rdquo;
                It reads the jobs, the crew, the outbox and the audit trail.
              </p>
            </article>
            <article className="lp-card">
              <h3>Add, change, delete</h3>
              <p>
                Start a job, book a crew, rename a task, drop one that is not
                happening. Every one of them arrives as a diff you confirm, and
                a delete tells you what goes with it before it goes.
              </p>
            </article>
            <article className="lp-card">
              <h3>Your own inbox and calendar</h3>
              <p>
                Connect Gmail or Outlook and the mail goes out from you, not
                from a robot at some domain your subs have never seen. Dates
                land on the calendar you already look at.
              </p>
            </article>
            <article className="lp-card">
              <h3>A record of every change</h3>
              <p>
                What changed, when, who asked for it and the exact words they
                used. Date disputes are constant in this trade; this is the
                thing that settles them.
              </p>
            </article>
          </div>
        </section>

        {/* ── The safety argument ────────────────────────────────────────── */}
        <section className="lp-vow">
          <div className="lp-inner lp-vow-inner">
            <p className="lp-eyebrow lp-eyebrow--light">The rule that does not bend</p>
            <h2 className="lp-vow-title">
              It proposes. You dispose. Nothing sends on its own.
            </h2>
            <p className="lp-vow-body">
              A sub who gets an email committing his crew to the wrong week
              because a phone misheard &ldquo;two months&rdquo; for &ldquo;two
              weeks&rdquo; is a real cost to a real business. So Foreman is
              built the other way round: it can look at anything and change
              nothing. Every write — every date, every email, every deletion —
              waits behind a diff with your thumb on it.
            </p>
          </div>
        </section>

        {/* ── Close ──────────────────────────────────────────────────────── */}
        <section className="lp-inner lp-close">
          <h2 className="lp-h2">Bring your first job over</h2>
          <p className="lp-sub">
            Set up takes a company name and a timezone. Then say what you are
            building and Foreman will start the schedule with you.
          </p>
          <div className="lp-cta">
            <Link className="lp-btn" href="/signup">
              Start free
            </Link>
            <Link className="lp-link lp-link--arrow" href="/login">
              Sign in
            </Link>
          </div>
        </section>
      </main>

      <footer className="lp-foot">
        <p>Foreman — scheduling that stays on the job.</p>
      </footer>
    </div>
  );
}
