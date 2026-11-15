# 12. Stage and status are separate columns

`stage` says where in the workflow a job is (`spec`, `build`, `review`, `approve`, `pr`,
`needs-human`, `completed`); `status` says what is happening there (`pending`, `running`,
`blocked`, `interrupted`, `completed`, `failed`, `cancelled`). A job can be `review`/`interrupted`.
`needs-human` is modelled as a stage with `status = blocked` and a `returnStage` so resumption
knows where to go back to.
