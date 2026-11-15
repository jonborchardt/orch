# 4. Runtime state in OS user directories, `ORCH_HOME` override

Windows: `%APPDATA%\orch` (config) and `%LOCALAPPDATA%\orch` (data). macOS: Application Support.
Linux: XDG. One env var redirects everything, which is how tests and development installs avoid
the real directories. Nothing mutable is ever written into the package install root or a Claude
skill directory, so `npm link` and junction-linked skills stay safe.
