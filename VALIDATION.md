# Verification

- 17 automated tests passed with a fake Claude process and real temporary Git repositories.
- The installed skill passed Codex skill validation.
- A read-only `skills/list` request to the installed Codex app server discovered Claudex as an enabled user skill with no loading errors.
- `claudex doctor` confirmed first-party `claude.ai` authentication and a Max subscription.
- A native Claude implementation worker completed a scoped change in an isolated test repository. Codex inspected the patch, verified the original file was unchanged, applied it with Git, and checked empty, nonempty, and negative inputs. The uncommitted user comment and Git index were preserved.

Live implementation artifacts: `/home/astrosteveo/.local/state/claudex/runs/20260908-210446-f48d627e82`. Provider metadata identified `claude-opus-5[1m]` for the implementation response.

A native Claude review completed in seven turns. Codex reproduced three of its findings as failing tests: an inherited Git index override mutated the test repository's index, text attributes normalized snapshot bytes, and an ASCII locale broke UTF-8 task input. Codex corrected them by clearing inherited Git overrides, neutralizing snapshot conversion attributes, and using explicit UTF-8 encoding. All three regression checks now pass.

Codex also expanded CLI flag checks and added safe compatibility diagnostics. The review's uncertainty about the native JSON auth contract was resolved by the successful real doctor and worker calls. The executable bit and native permission-denials field were checked. The final corrections were validated by tests; Claude did not perform a second review of the corrected revision.

Independent review artifacts: `/home/astrosteveo/.local/state/claudex/runs/20260908-210411-0aef71d655`.

Automated checks do not establish model-routing quality for every future prompt. Remaining quota is not exposed by the bridge. The implementation snapshot limits are documented in README.md.
