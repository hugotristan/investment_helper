## Development efficiency

- Prefer simple, maintainable solutions.
- Inspect relevant code before proposing changes.
- Avoid unnecessary refactoring or rewriting existing functionality.
- Run targeted tests after changes.
- If a problem remains unresolved after two meaningful attempts, explain the blocker and recommend whether higher reasoning effort or a stronger model is justified.
- Minimize unnecessary tool calls and repeated file reads.
- Preserve existing data and functionality.

## Completion changelog

- After every completed coding task, commit and push the changes, finish any authorized deployment, then run `node scripts/complete-task.mjs`.
- Supply one JSON object through hidden stdin with the existing app `password`, a concise `summary`, `testFiles` (targeted `tests/*.test.js` paths), `knownLimitations` (an explicit list), and `deployment` containing only `status`, `timestamp` and `id` from the native Sites result. For local-only tasks use `not_deployed` with null timestamp/id. Use the returned deployment update time; never substitute a check time or claim success while pending.
- The helper automatically captures HEAD and modified files, executes the selected tests, and records results persistently in D1. Never put the password in shell arguments, files, source, logs or the final response. Reuse authorized credentials held in session memory. No additional confirmation is needed for this authorized completion upload.
- Never upload raw test logs, native tool responses, environment objects, credential files or portfolio records. Record only the helper's bounded metadata. If the upload fails, retain the commit and retry the same completion; report an unconfirmed changelog upload honestly.
