# 3. `node:util` `parseArgs` for the CLI

A handful of commands does not justify a CLI framework. All options are declared once in
`src/cli/main.ts`; subcommands pick what they need. Help text is a string. Revisit only if the
option set becomes unmanageable.
