# 28. Reviewers are read-only, enforced two ways

Reviewer and approver agents have no `Edit` tool, and the plan carries a worktree fingerprint
(HEAD plus the sorted dirty-file list) that `orch factory check-readonly` compares after the round.
A changed worktree fails the round rather than letting a reviewer's edit slip into the diff. This
does not stop a process with filesystem access from writing anywhere; it detects it.
