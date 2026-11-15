# 34. Liveness is reported, not inferred

The board shows `running (lease live)` versus `last reported running` (status `running`, lease
lapsed). Both are derived from the row; neither claims a process exists. A dedicated heartbeat or
process table was rejected because there is no daemon to maintain it.
