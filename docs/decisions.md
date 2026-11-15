# Decisions

Short records of choices that are not obvious from the code live in `docs/decisions/`, one file
per decision. Read them with `ls docs/decisions`; nothing indexes them, so parallel branches never
edit the same file to add one.

## Adding a decision

Create `docs/decisions/YYYY-MM-DD-<slug>.md` (today's date, a short kebab-case slug) with a title
line, the decision, and a short rationale. No number to claim, no list to append to; two branches
adding decisions on the same day touch different files. Refer to a decision by its filename, or by
its number for the historical ones.

## Historical numbering

Decisions 1 to 62 were written in this file with sequential numbers; they keep those numbers as
the filename prefix (`docs/decisions/045-*.md` is "decision 45"), so existing references such as
"decision 45" or "#45" still resolve. Headings such as "(Phase 1)" or "(Phase 2, C02)" name the
development phase they were written in; two phase schemes were used over time.
