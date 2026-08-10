"use client";

import { useMemo, useState, type FormEvent } from "react";

type Project = { id: string; name: string; location: string; color: string };
type Person = { id: string; name: string; email: string; role: string; initials: string };
type ScheduleEvent = { id: string; title: string; projectId: string; assigneeIds: string[]; date: string; startTime: string; durationMinutes: number; trade: string; notes: string; createdAt: string };
type Notification = { id: string; eventId: string; personId: string; channel: "email"; status: "sent"; subject: string; createdAt: string };
export type ManagementDatabase = { company: { name: string; timezone: string }; projects: Project[]; people: Person[]; events: ScheduleEvent[]; notifications: Notification[] };

type Props = {
  mode: "projects" | "crew";
  database: ManagementDatabase;
  onDatabase: (database: ManagementDatabase) => void;
  onOpenSchedule: (projectId?: string) => void;
};

const colors = ["#d85b43", "#447a72", "#b68a2f", "#4778a8", "#9b5875", "#7862a1"];
function tone(index: number) { return ["clay", "sage", "gold", "blue", "rose", "plum"][index % 6]; }

export default function ManagementViews({ mode, database, onDatabase, onOpenSchedule }: Props) {
  const [modal, setModal] = useState<"project" | "person" | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const peopleById = useMemo(() => new Map(database.people.map((person) => [person.id, person])), [database.people]);

  async function addProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true); setError("");
    const form = new FormData(event.currentTarget);
    const response = await fetch("/api/projects", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: form.get("name"), location: form.get("location"), color: form.get("color") }) });
    const result = await response.json() as { database?: ManagementDatabase; error?: string };
    setSaving(false);
    if (!response.ok || !result.database) { setError(result.error || "The project could not be added."); return; }
    onDatabase(result.database); setModal(null);
  }

  async function addPerson(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true); setError("");
    const form = new FormData(event.currentTarget);
    const response = await fetch("/api/people", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: form.get("name"), role: form.get("role"), email: form.get("email") }) });
    const result = await response.json() as { database?: ManagementDatabase; error?: string };
    setSaving(false);
    if (!response.ok || !result.database) { setError(result.error || "The crew member could not be added."); return; }
    onDatabase(result.database); setModal(null);
  }

  async function removeProject(project: Project) {
    const jobCount = database.events.filter((event) => event.projectId === project.id).length;
    if (!window.confirm(`Delete ${project.name}${jobCount ? ` and its ${jobCount} scheduled job${jobCount === 1 ? "" : "s"}` : ""}? This cannot be undone.`)) return;
    const response = await fetch("/api/projects", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: project.id }) });
    const result = await response.json() as { database?: ManagementDatabase; error?: string };
    if (!response.ok || !result.database) { window.alert(result.error || "The project could not be deleted."); return; }
    onDatabase(result.database);
  }

  async function removePerson(person: Person) {
    const jobCount = database.events.filter((event) => event.assigneeIds.includes(person.id)).length;
    if (!window.confirm(`Remove ${person.name} from the crew${jobCount ? ` and unassign them from ${jobCount} job${jobCount === 1 ? "" : "s"}` : ""}?`)) return;
    const response = await fetch("/api/people", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: person.id }) });
    const result = await response.json() as { database?: ManagementDatabase; error?: string };
    if (!response.ok || !result.database) { window.alert(result.error || "The crew member could not be deleted."); return; }
    onDatabase(result.database);
  }

  return (
    <>
      <section className="management-hero">
        <div><span>{mode === "projects" ? "ACTIVE PORTFOLIO" : "FIELD DIRECTORY"}</span><h2>{mode === "projects" ? "Projects" : "Crew"}</h2><p>{mode === "projects" ? "See every project, its schedule, and assigned crew in one place." : "Manage the people Foreman can assign and notify about schedule changes."}</p></div>
        <button className="management-add" onClick={() => { setError(""); setModal(mode === "projects" ? "project" : "person"); }}><span>+</span>{mode === "projects" ? "Add project" : "Add crew member"}</button>
      </section>

      {mode === "projects" ? (
        <section className="management-grid" data-testid="projects-view">
          {database.projects.map((project) => {
            const jobs = database.events.filter((event) => event.projectId === project.id);
            const crewIds = new Set(jobs.flatMap((event) => event.assigneeIds));
            const nextJob = [...jobs].filter((event) => event.date >= new Date().toLocaleDateString("en-CA")).sort((a, b) => `${a.date}${a.startTime}`.localeCompare(`${b.date}${b.startTime}`))[0];
            return <article className="project-card" key={project.id} style={{ "--project-color": project.color } as React.CSSProperties}>
              <div className="project-card-accent" />
              <div className="project-card-head"><span className="project-monogram">{project.name.split(/\s+/).slice(0, 2).map((word) => word[0]).join("")}</span><button className="icon-delete" onClick={() => void removeProject(project)} aria-label={`Delete ${project.name}`}>×</button></div>
              <h3>{project.name}</h3><p className="project-location">⌖ {project.location}</p>
              <div className="project-stats"><span><strong>{jobs.length}</strong> jobs</span><span><strong>{crewIds.size}</strong> crew</span></div>
              <div className="project-next"><small>NEXT ON SITE</small>{nextJob ? <><strong>{nextJob.title}</strong><span>{nextJob.date} at {nextJob.startTime}</span></> : <span>No upcoming work</span>}</div>
              <div className="project-card-foot"><div className="mini-crew">{[...crewIds].slice(0, 4).map((id, index) => <span className={`avatar ${tone(index)}`} key={id}>{peopleById.get(id)?.initials || "?"}</span>)}</div><button onClick={() => onOpenSchedule(project.id)}>Open schedule →</button></div>
            </article>;
          })}
          {!database.projects.length && <div className="empty-management"><span>□</span><h3>No projects yet</h3><p>Add the first project to start scheduling work.</p></div>}
        </section>
      ) : (
        <section className="crew-directory" data-testid="crew-view">
          <div className="directory-head"><span>Team member</span><span>Role</span><span>Assigned work</span><span>Email status</span><span /></div>
          {database.people.map((person, index) => {
            const jobs = database.events.filter((event) => event.assigneeIds.includes(person.id));
            const notices = database.notifications.filter((notice) => notice.personId === person.id).length;
            return <article className="crew-directory-row" key={person.id}>
              <div className="directory-person"><span className={`avatar ${tone(index)}`}>{person.initials}</span><p><strong>{person.name}</strong><small>{person.email}</small></p></div>
              <span className="role-pill">{person.role}</span>
              <span><strong>{jobs.length}</strong> scheduled job{jobs.length === 1 ? "" : "s"}</span>
              <span className="email-ready"><i /> {notices ? `${notices} demo email${notices === 1 ? "" : "s"} logged` : "Ready to notify"}</span>
              <button className="icon-delete" onClick={() => void removePerson(person)} aria-label={`Remove ${person.name}`}>×</button>
            </article>;
          })}
          {!database.people.length && <div className="empty-management"><span>♙</span><h3>No crew yet</h3><p>Add a crew member so Foreman can assign and notify them.</p></div>}
        </section>
      )}

      {modal && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setModal(null); }}><section className="job-modal compact-modal" role="dialog" aria-modal="true" aria-labelledby="management-modal-title"><div className="modal-head"><div><span>{modal === "project" ? "NEW PROJECT" : "NEW TEAM MEMBER"}</span><h2 id="management-modal-title">{modal === "project" ? "Add a project" : "Add crew member"}</h2></div><button onClick={() => setModal(null)} aria-label="Close">×</button></div>
        {modal === "project" ? <form onSubmit={(event) => void addProject(event)}><label>Project name<input name="name" required minLength={2} placeholder="e.g. Riverbend Apartments" /></label><label>Location<input name="location" required minLength={2} placeholder="City or job-site address" /></label><fieldset className="color-picker"><legend>Project color</legend>{colors.map((color, index) => <label key={color} style={{ background: color }}><input type="radio" name="color" value={color} defaultChecked={index === 0} /><span>✓</span></label>)}</fieldset>{error && <p className="form-error">{error}</p>}<div className="modal-actions"><button type="button" onClick={() => setModal(null)}>Cancel</button><button type="submit" disabled={saving}>{saving ? "Adding…" : "Add project"}</button></div></form>
        : <form onSubmit={(event) => void addPerson(event)}><label>Full name<input name="name" required minLength={2} placeholder="e.g. James Foster" /></label><label>Role<input name="role" required minLength={2} placeholder="e.g. Project Engineer" /></label><label>Email<input name="email" type="email" required placeholder="james@company.com" /></label><p className="form-help">Foreman will log a demo email whenever this person is assigned or their timing changes.</p>{error && <p className="form-error">{error}</p>}<div className="modal-actions"><button type="button" onClick={() => setModal(null)}>Cancel</button><button type="submit" disabled={saving}>{saving ? "Adding…" : "Add crew member"}</button></div></form>}
      </section></div>}
    </>
  );
}
