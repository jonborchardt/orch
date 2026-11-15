# 24. Repository identity from the configured remote URL

(Since decision 49 this identity follows the remote and no longer binds a job to its repository.)

`describeRepo` reads `git config --get remote.origin.url`, not `git remote get-url`, which applies
`url.<x>.insteadOf` rewrites. The configured URL is what the user thinks of as "the repository";
rewrites are transport details (and the test suite uses one to point a GitHub-looking origin at a
local bare repository).
