# The board table is hand-rolled MUI, not a data grid

**Decision.** Column choice, sorting, and filtering on the job board use `@mui/material` parts
already installed (`TableSortLabel`, `Menu`, `Checkbox`, `TextField`) in `web/src/JobBoard.tsx`:
a column list with a visibility menu, single-column sort on header click, and one free-text filter
that combines with the Repository and Show selects. Column visibility is a per-browser preference
in `localStorage`; Repository, Session, and Branch / worktree start hidden; Job, Status, and the
row Actions column cannot be hidden.

**Rejected.** `@mui/x-data-grid`: a new dependency whose versions couple to `@mui/material` 9, for
per-column filter menus, multi-column sort, and pagination the board does not need at tens of
rows. Server-side column preferences: a view choice is not job state. Revisit if one text filter
proves too coarse.
