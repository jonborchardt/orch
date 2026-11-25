# A spec escalation may re-register spec.md while in needs-human

Ticket 0160. Workflow artifacts can only be registered while the job is in the stage that owns
them (`assertStageOwns` in `src/core/artifact-rules.ts`). One exception: a job in `needs-human`
whose `returnStage` is `spec` may register `spec.md` (with `--replace`), and the row keeps stage
`spec`. Every other artifact, and `spec.md` under any other `returnStage`, is refused as before.

The dashboard's `edit-spec` action uses this to save a human's edit through `addArtifact`, the
same path as `orch job artifact add --replace`: validated before it touches disk, hashed, and
logged as `artifact.replaced`. It does not move the job; the person then answers the
resume-to-spec choice.

Rationale: answering a spec escalation otherwise means editing a file under the artifacts
directory by hand. The gate is unchanged: a spec challenge is bound to the hash of the spec.md
registered when it was recorded, so the edited spec cannot leave `spec` until the challenger has
reviewed the new hash.
