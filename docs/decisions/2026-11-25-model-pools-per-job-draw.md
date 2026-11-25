# Model pools: a random per-job draw made in code, pruned only by the person

Ticket 0168. `models.<role>` in `<config>/factory.json` is a model or a pool of models.
`createJob` draws one model per role, uniform over the pool, from a sha256 of the job id and role,
and records the draw as the job's `models.drawn` event. Review rows carry the reviewer's model and
whether it matches the builder's.

Why random: the factory runs a continuous experiment on real work. A uniform draw spreads each
model over the same mix of tickets, so later comparisons are not biased by who chose which model
for which job. The draw is in TypeScript, never in skill prose or an agent's judgement, so it
cannot be steered and the evidence is not a claim.

Why per job: a model that changed between rounds or sessions would mix two models' work in one
result and make the record unreadable. Hashing the job id and role gives the same answer on every
call, platform, and Node version without storing a seed. The event is written once, in the job's
insert transaction, so a later pool edit does not change a running job.

Why no exclusion rule: forcing a reviewer to differ from the builder would make "same model judged
its own work" impossible to observe, and that is one of the things the experiment measures. The
`sameAsAuthor` flag records it instead.

Why the person prunes: what counts as a bad model is a judgement about results the person reads
(metrics are a later ticket). orch never removes, reweights, or adapts a pool; it only draws and
records.
