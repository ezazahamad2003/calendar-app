import type { SetupProblem } from "@/lib/setup";

/**
 * What a half-configured deployment shows instead of a 500.
 *
 * Deliberately plain and specific: the person reading it is standing in the
 * Vercel dashboard trying to work out what to click.
 */
export function SetupScreen({ problems }: { problems: SetupProblem[] }) {
  return (
    <div className="setup">
      <div className="setup-card">
        <h1>Almost there</h1>
        <p>
          The app is deployed but not finished being set up. Once this is done it
          goes straight to the schedule — there is no sign-in.
        </p>
        <ul className="setup-list">
          {problems.map((problem) => (
            <li key={problem.title}>
              <strong>{problem.title}</strong>
              <span>{problem.message}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
