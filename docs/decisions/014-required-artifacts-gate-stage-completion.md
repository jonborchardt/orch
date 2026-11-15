# 14. Required artifacts gate stage completion

A stage completes only after its required Markdown artifact (`spec.md`, `build.md`,
`round-N/consolidated.md`, `decision.md`, `pr.md`) has been registered through `orch job artifact
add`, which checks the file is inside the job's artifact directory, is `.md`, exists, and is
non-empty. The database stores paths and sizes, not content. A file merely existing on disk is not
evidence of completion. The `pr` stage additionally requires a recorded PR (`orch job pr`).
