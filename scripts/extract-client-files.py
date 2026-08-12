"""
Turn the client's two files into the JSON the app ships with.

    SHOP.mpp             the master construction sequence — what follows what
    AG SHOP 8.10.26.xls  the wall chart on the office wall — what is happening now

Both are OLE compound files. The .mpp is read with MPXJ (via a JVM), the .xls
with xlrd. Neither library is a runtime dependency of the app: this script runs
once, by hand, and its output is committed.

    python scripts/extract-client-files.py

Writes `data/master-plan.json` (the .mpp, kept for reference and for seeding a
future job) and `data/seed.json` (the live schedule the app boots with).

Why the wall chart is the live data and the .mpp is only reference: the .mpp was
authored in September 2025 and stops at the structural phases, which are long
finished. The wall chart is dated 8.10.26 and covers the finish-out that is
actually in front of the crew. The .mpp's value now is the *shape* of a
construction chain, not its dates.
"""

from __future__ import annotations

import datetime as dt
import glob
import json
import os
import re
import sys

DOWNLOADS = os.path.expanduser("~/Downloads")
MPP = os.path.join(DOWNLOADS, "SHOP.mpp")
XLS = os.path.join(DOWNLOADS, "AG SHOP 8.10.26.xls")
OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data")

# The wall chart's first day column. Row 5 reads "M" and row 6 reads "10" under
# the AUGUST banner; 10 August 2026 is a Monday, which is what pins the year —
# the sheet itself never writes one.
GRID_ORIGIN = dt.date(2026, 8, 10)
FIRST_DAY_COL = 2
LAST_DAY_COL = 64

WORKING_DAYS = [1, 2, 3, 4, 5]  # ISO: Mon–Fri


# ── the .mpp ──────────────────────────────────────────────────────────────────

def read_master_plan() -> dict:
    """The construction sequence, as Microsoft Project has it."""
    import jpype
    import jpype.imports
    import mpxj

    if not jpype.isJVMStarted():
        libs = glob.glob(os.path.join(os.path.dirname(mpxj.__file__), "lib", "*.jar"))
        jpype.startJVM(classpath=libs)

    from org.mpxj.reader import UniversalProjectReader

    project = UniversalProjectReader().read(MPP)

    tasks = []
    for task in project.getTasks():
        name = task.getName()
        # The synthetic level-0 row is the project itself, not work.
        if name is None or int(task.getOutlineLevel() or 0) == 0:
            continue

        start = task.getStart()
        finish = task.getFinish()
        duration = task.getDuration()

        tasks.append(
            {
                "id": int(task.getID()),
                "name": squash(str(name)),
                "startDate": str(start)[:10] if start else None,
                "finishDate": str(finish)[:10] if finish else None,
                "durationDays": int(duration.getDuration()) if duration else 1,
                "predecessors": [
                    {
                        "id": int(rel.getPredecessorTask().getID()),
                        "type": str(rel.getType()),
                        "lagDays": int(rel.getLag().getDuration()) if rel.getLag() else 0,
                    }
                    for rel in (task.getPredecessors() or [])
                ],
            }
        )

    props = project.getProjectProperties()
    return {
        "source": "SHOP.mpp",
        "note": (
            "Master construction sequence as authored in Microsoft Project, "
            "September 2025. Reference only — the live schedule is seed.json. "
            "Kept because it is the record of which trade follows which."
        ),
        "startDate": str(props.getStartDate())[:10] if props.getStartDate() else None,
        "finishDate": str(props.getFinishDate())[:10] if props.getFinishDate() else None,
        "tasks": tasks,
    }


# ── the .xls ──────────────────────────────────────────────────────────────────

def squash(text: str) -> str:
    """The wall chart is full of double spaces from manual column fitting."""
    return re.sub(r"\s+", " ", text).strip()


def col_date(col: int) -> dt.date:
    return GRID_ORIGIN + dt.timedelta(days=col - FIRST_DAY_COL)


def is_working(day: dt.date) -> bool:
    return day.isoweekday() in WORKING_DAYS


# X means booked, ? means pencilled in, D means already done. Anything else in a
# day cell is someone's shorthand and is treated as booked rather than dropped.
MARK_STATUS = {"X": "confirmed", "?": "tentative", "D": "done"}


def read_wall_chart() -> tuple[list[dict], list[dict]]:
    """Sections and activities, as the wall chart has them."""
    import xlrd

    book = xlrd.open_workbook(XLS)
    sheet = book.sheet_by_name("Master")

    sections: list[dict] = []
    rows: list[dict] = []
    current_section: str | None = None

    for r in range(7, sheet.nrows):
        team = squash(str(sheet.cell_value(r, 0)))
        activity = squash(str(sheet.cell_value(r, 1)))

        # A section banner: a label in one of the first two columns and no days
        # marked on the row. "TEAM" is the column heading, not a section.
        marks = [
            (c, squash(str(sheet.cell_value(r, c))))
            for c in range(FIRST_DAY_COL, LAST_DAY_COL + 1)
            if squash(str(sheet.cell_value(r, c)))
        ]

        banner = (activity or team) if not marks and not (team and activity) else None
        if banner and banner.upper() == "TEAM":
            continue
        if banner:
            current_section = banner
            sections.append({"name": banner})
            continue

        if not activity:
            continue

        rows.append(
            {
                "section": current_section,
                # "?" appears in the team column where the sub is not chosen yet.
                "team": None if team in ("", "?") else team,
                "name": activity,
                "marks": marks,
                "sourceRow": r,
            }
        )

    return sections, rows


def spans(marks: list[tuple[int, str]]) -> list[dict]:
    """
    Group day marks into runs of consecutive *working* days.

    A row marked Friday and Monday with the weekend shaded between is one
    two-day job, not two one-day jobs — the crew does not consider the weekend
    a gap. A genuine gap (a trade coming back a month later) does split, and
    becomes a second activity, because a task in this app occupies one
    contiguous run of work days.
    """
    if not marks:
        return []

    out: list[dict] = []
    run: list[tuple[dt.date, str]] = []

    def flush() -> None:
        if not run:
            return
        # The whole run takes its status from the weakest mark on it: a span
        # with one tentative day is not a confirmed booking.
        rank = {"done": 0, "confirmed": 1, "tentative": 2}
        status = max((s for _, s in run), key=lambda s: rank[s])
        out.append({"startDate": run[0][0].isoformat(), "durationDays": len(run), "status": status})

    for col, mark in marks:
        day = col_date(col)
        if not is_working(day):
            # A mark on a shaded weekend column is weekend work; keep it rather
            # than silently dropping a booking.
            pass
        status = MARK_STATUS.get(mark.upper(), "confirmed")

        if run:
            previous = run[-1][0]
            step = previous + dt.timedelta(days=1)
            while not is_working(step):
                step += dt.timedelta(days=1)
            if day != step:
                flush()
                run = []
        run.append((day, status))

    flush()
    return out


# ── dependencies ──────────────────────────────────────────────────────────────
#
# Matched on the activity text rather than row numbers so that re-running this
# after the client edits the sheet does not silently rewire the schedule to the
# wrong trades. An unmatched pattern is reported, not ignored.
#
# Only chains the source actually evidences are wired. Over-wiring is worse than
# under-wiring here: every edge is a route by which a two-day slip travels, and
# an invented edge moves a crew that had no reason to move.

DEPENDENCIES: list[tuple[str, str, str]] = [
    # Fire system: riser, then hydro, then the pump test, then the two sign-offs.
    ("Install Fire Riser sprinkler", "Hydro Fire pump room", "FS"),
    ("Hydro Fire pump room", "Fire pump Start up / Test / Flush", "FS"),
    ("Fire pump Start up / Test / Flush", "The Fire Consultant inpection", "FS"),
    ("Fire pump Start up / Test / Flush", "INSPECTION", "SS"),
    # Sitework: grade, inspect the rebar, pour, then pave over it.
    ("Finish Grade for AC and Concrete", "Rebar inspection", "FS"),
    ("Finish grade West side HELI PAD", "Pour Heli Pad", "FS"),
    ("Rebar inspection", "Pour Heli Pad", "FS"),
    ("Pour Heli Pad", "Paving", "FS"),
    ("Paving", "Concrete entry drive", "FS"),
    # The activity name states this one outright.
    ("Install bathroom Door", "Install Wainscot in Bathroom after door install", "FS"),
    # Interior electrical before the exterior/finish pass.
    ("Interior finish", "Finish Electrical / Exterior Lighitng", "FS"),
    # Everything the county needs signed off before it will do a final.
    ("INSPECTION", "Final inspection", "FS"),
    ("Finish Electrical / Exterior Lighitng", "Final inspection", "FS"),
    ("Finish plumbing", "Final inspection", "FS"),
    ("Paving", "Final inspection", "FS"),
    ("Finish Solar install", "Final inspection", "FS"),
]


def add_work_days(start: dt.date, n: int) -> dt.date:
    """Mirror of `addWorkDays` in src/lib/schedule/date.ts."""
    step = -1 if n < 0 else 1
    cursor = start
    while not is_working(cursor):
        cursor += dt.timedelta(days=step)
    for _ in range(abs(n)):
        cursor += dt.timedelta(days=step)
        while not is_working(cursor):
            cursor += dt.timedelta(days=step)
    return cursor


def work_days_between(a: dt.date, b: dt.date) -> int:
    """Mirror of `workDaysBetween`. Signed; steps between, not days occupied."""
    while not is_working(a):
        a += dt.timedelta(days=1)
    while not is_working(b):
        b += dt.timedelta(days=1)
    if a == b:
        return 0
    forward = b > a
    step = 1 if forward else -1
    cursor, count = a, 0
    while cursor != b:
        cursor += dt.timedelta(days=step)
        if is_working(cursor):
            count += 1
    return count if forward else -count


def fitted_lag(pred: dict, succ: dict, dep_type: str) -> int:
    """
    The lag that makes this link agree with the dates already on the wall.

    The wall chart records dates and the crew's ordering knowledge separately —
    it has no lag column. If the links are imported with zero lag, the very
    first cascade snaps every successor tight against its predecessor and the
    app's opening screen disagrees with the chart it was built from.

    So each link is fitted to the gap that is actually there. That gap is real
    scheduling intent — cure time, a sub who only comes Tuesdays, a week of
    slack before the county visit — and preserving it is what makes a two-day
    slip land two days later downstream rather than collapsing the schedule.

    Undated on either end means nothing to fit against, so zero.
    """
    if not pred["startDate"] or not succ["startDate"]:
        return 0

    pred_start = dt.date.fromisoformat(pred["startDate"])
    succ_start = dt.date.fromisoformat(succ["startDate"])
    pred_finish = add_work_days(pred_start, pred["durationDays"] - 1)

    if dep_type == "FS":
        return work_days_between(add_work_days(pred_finish, 1), succ_start)
    if dep_type == "SS":
        return work_days_between(pred_start, succ_start)
    if dep_type == "FF":
        succ_finish = add_work_days(succ_start, succ["durationDays"] - 1)
        return work_days_between(pred_finish, succ_finish)
    # SF: the successor finishes when the predecessor starts.
    succ_finish = add_work_days(succ_start, succ["durationDays"] - 1)
    return work_days_between(pred_start, succ_finish)


def main() -> int:
    for path in (MPP, XLS):
        if not os.path.exists(path):
            print(f"missing: {path}", file=sys.stderr)
            return 1

    os.makedirs(OUT, exist_ok=True)

    master = read_master_plan()
    with open(os.path.join(OUT, "master-plan.json"), "w", encoding="utf-8") as fh:
        json.dump(master, fh, indent=2)
        fh.write("\n")
    print(f"master-plan.json  {len(master['tasks'])} tasks")

    sections, rows = read_wall_chart()

    tasks: list[dict] = []
    by_name: dict[str, str] = {}
    order = 0

    for row in rows:
        runs = spans(row["marks"])
        # A row with no marks is real work with no date yet — the backlog the
        # wall chart carries down its left edge. It must survive the import.
        if not runs:
            runs = [{"startDate": None, "durationDays": 1, "status": "planned"}]

        for index, run in enumerate(runs):
            slug = re.sub(r"[^a-z0-9]+", "-", row["name"].lower()).strip("-")[:48]
            task_id = slug if index == 0 else f"{slug}-{index + 1}"
            tasks.append(
                {
                    "id": task_id,
                    "section": row["section"],
                    "name": row["name"],
                    "team": row["team"],
                    "startDate": run["startDate"],
                    "durationDays": run["durationDays"],
                    "status": run["status"],
                    "order": order,
                }
            )
            order += 1
            # Dependencies name an activity; they mean its first occurrence.
            by_name.setdefault(row["name"], task_id)

    by_id = {t["id"]: t for t in tasks}

    deps = []
    for predecessor, successor, dep_type in DEPENDENCIES:
        a, b = by_name.get(predecessor), by_name.get(successor)
        if not a or not b:
            print(f"  ! unmatched dependency {predecessor!r} -> {successor!r}", file=sys.stderr)
            continue
        deps.append(
            {
                "predecessorId": a,
                "successorId": b,
                "depType": dep_type,
                "lagDays": fitted_lag(by_id[a], by_id[b], dep_type),
            }
        )

    seed = {
        "source": "AG SHOP 8.10.26.xls",
        "project": {
            "name": "Suisun AG Shop",
            "client": "Adair Family Wines",
            "timezone": "America/Los_Angeles",
        },
        "calendar": {"workingDays": WORKING_DAYS, "holidays": []},
        "sections": [s["name"] for s in sections],
        "tasks": tasks,
        "deps": deps,
    }

    with open(os.path.join(OUT, "seed.json"), "w", encoding="utf-8") as fh:
        json.dump(seed, fh, indent=2)
        fh.write("\n")

    dated = sum(1 for t in tasks if t["startDate"])
    print(f"seed.json         {len(tasks)} activities ({dated} dated), {len(deps)} links")
    print(f"                  sections: {', '.join(seed['sections'])}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
