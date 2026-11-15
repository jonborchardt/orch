# 30. Managed copies as the last resort for agent files

Windows without Developer Mode refuses file symlinks, and hard links cannot cross volumes, which is
exactly the common layout of a repo on one drive and `~/.claude` on `C:`. `orch install` then writes
a copy with a trailer `<!-- orch-managed-copy: <source> -->`. Copies are recognised by that trailer
and refreshed when stale; a file without it, or with another source, is a conflict and is never
touched. Skills still link as junctions, so only the agent files lose liveness. Copying the whole
`agents` directory as a junction was rejected because it would capture the user's own agents.
