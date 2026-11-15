# 19. Replacing an artifact is explicit and hashed

`artifacts.sha256` records what was accepted. Re-registering identical content is idempotent;
different content is refused without `--replace`, and the replacement is logged as
`artifact.replaced` with the previous hash. `--revision <n>` still applies. This keeps builders
from silently rewriting `build.md` under a running review while allowing the normal rework round
(`--replace`) and leaves a durable trail of what each stage accepted.
