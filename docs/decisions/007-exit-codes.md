# 7. Exit codes

0 success; 1 failed check, validation, or illegal workflow transition; 2 usage error; 3 not found;
4 ownership (owned by another session, bad or stale token, stale revision). Distinct codes let a
skill branch on "someone else owns this" without parsing messages. With `--json`, errors are
printed to stderr as `{"error":{"type","message","exitCode"}}`.
