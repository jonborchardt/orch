# 2. Node native type stripping instead of `tsx`

Node runs `.ts` files directly. `erasableSyntaxOnly` in `tsconfig.json` guarantees source stays
strippable (no enums, parameter properties, or namespaces). Relative imports use `.ts` extensions;
`rewriteRelativeImportExtensions` makes `tsc` emit `.js` in `dist/`. One less dependency and one
less execution path to debug. (Minimum engine raised to Node 24 in decision 11.)
