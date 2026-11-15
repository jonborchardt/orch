# Decisions are one file each, named by date and slug

`docs/decisions.md` was a single append-only list with sequential numbers. Every parallel branch
that added a decision claimed the next number, and the merges collided (the same number appended
twice, or a renumbering that left "decision 48" pointing at the wrong record). The list is now
`docs/decisions/`, one file per decision, named `YYYY-MM-DD-<slug>.md`; the 62 historical decisions
keep their numbers as a zero-padded filename prefix so existing references still resolve.

Why not a counter, a registry, or decimal numbers: any shared sequence or index file is the thing
that conflicts. A dated filename needs no coordination, sorts chronologically in `ls`, and a same-day
same-slug collision shows up as an add/add conflict on exactly that file. Nothing reads these files
programmatically, so no tooling is needed.
