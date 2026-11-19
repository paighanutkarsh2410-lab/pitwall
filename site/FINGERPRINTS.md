# Fingerprints

Every site you build with **scroll-craft** gets one row here, appended after it
ships. The registry exists so your next build can prove it is a different page
rather than a re-skin of one you already made.

This file is **yours**. It starts empty on purpose: the gate is about not
repeating *yourself*, so it has nothing to say until you have built something.

The rules and the gate live in the skill's
`references/uniqueness.md`. Short version:

**A new build must differ from EVERY row below on at least 4 of the 6
dimensions.** Four against each row individually, not four on average across the
table. If a planned build fails, change the plan. Never edit a row to make room
for it.

The six dimensions are: **grammar**, **nav treatment**, **hero device**,
**act-sequence shape**, **close pattern**, **signature move**.

Dimension 6 is free, because a signature move is unique by definition. So the
gate really asks for three more out of the remaining five, and a build that
changes only grammar and world will fail it.

---

## The registry

| Build | Grammar | Nav treatment | Hero device | Act-sequence shape | Close pattern | Signature move | World | Port |
|---|---|---|---|---|---|---|---|---|

*(empty: your first build has nothing to clear, so build whatever the interview
points at. From the second onwards, this table is the constraint.)*

---

## What is taken

Add a bullet here whenever a build claims something a later build should avoid
reusing: a grammar, a nav treatment, a close pattern, a signature move, an
act-count-and-length band. The shared columns are what the next build inherits
as a constraint, so writing them down is the whole point.

Nothing is taken yet.

---

## Appending a row

After shipping, add one line to the table and one bullet to **What is taken** if
the build claimed something new. Fill every column. Say what the build shares
with existing rows.

Rows are append-only. A build that has been superseded stays in the table,
because the space it occupies is still occupied.

---

## Worked example

The skill's author kept a registry of twelve builds across eight page grammars.
If you want to see what a filled-in table looks like, and which shapes tend to
collide, read `EXAMPLES.md` in the scroll-craft repository. Treat it as
illustration only: those rows are somebody else's builds and they do **not**
constrain yours.
| pitwall-race | Race broadcast (new: director's cuts under a persistent graphics layer) | Broadcast graphics package: loud bar with site tabs, live lap counter, track-status lamp, and a fixed timing tower | Start lights on their own clock over layered planes: real circuit far, real grid mid, rain near, type in front | 11 short unpinned cuts in race order (lights, morph, lap chart, race control, red flag, restart, lead, pass, numbers, flag, hand-off), about 12.3 vh, hard per-shot grounds | Chequered flag, then an abrupt full-bleed accent hand-off: one line, one button, footer inside | Page scroll is the race clock: the tower re-sorts lap by lap from real data and unfurls at the peak | Data-drawn broadcast at night in the rain: no imagery, everything from the race's own data | Pitwall site, tab 1 |
| pitwall-engineering | Chaptered editorial | Static site-tab strip; a vertical folio in the margin with chapter number and title | Title page: type on cool paper, no media | Title, one pinned drawing chapter (2.4 vh), four flow chapters with hard grounds (one dark), colophon; about 7.5 vh | Colophon: running-text invitation (`./pitwall up`), stack list, small print | Follow one event: a real lap event travels a self-drawing technical drawing, each stage stamped with its measured latency | Technical drawing on cool paper; numbers as evidence | Pitwall site, tab 3 |
