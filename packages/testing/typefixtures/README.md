# Compile-fail type fixtures

Each `*.ts` file here proves that one strict compiler option from `tsconfig.base.json` is in
force. Every violation is marked with a directive of the form

```ts
// @ts-expect-error TS<code> <option>: <why this line must not compile>
```

Two checks keep these fixtures honest:

1. `tsc -b` (root `pnpm typecheck`, or `pnpm --filter @blackwing/testing typecheck`) builds this
   project through the `references` of `packages/testing/tsconfig.json`. If an option is ever
   relaxed, the marked line compiles, the directive becomes unused (TS2578) and the build fails.
2. `packages/testing/src/typefixtures.test.ts` strips each directive, compiles the fixture with the
   effective options of this project and asserts that exactly the declared `TS<code>` is reported
   on the marked line, so a directive cannot be satisfied by an unrelated error (a typo, a missing
   import). It also asserts that every option listed in the test has at least one fixture.

Add a fixture whenever a strict option is added to the base config. Never delete one to make a
relaxed config pass: relaxing app code is not allowed (FOUND-003).
