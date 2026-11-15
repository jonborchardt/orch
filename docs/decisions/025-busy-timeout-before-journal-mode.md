# 25. `busy_timeout` before `journal_mode`

Switching to WAL takes a lock. With five CLI processes opening the database at once, setting the
journal mode before the busy timeout produced sporadic `database is locked` failures. The pragmas
are ordered timeout first.
