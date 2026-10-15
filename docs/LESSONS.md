# Lessons learned

Every item below is a real failure that happened while building this bridge, not a
hypothetical. They are written down because each one was **silent** — the program kept
running and looked fine while being wrong.

---

## 1. A mail app's automatic signature broke command detection

**Symptom.** Sending a body containing only `new session` did nothing. The session was never
reset, so the bot kept dragging around a huge conversation.

**What was actually in the mailbox.** The phone's mail app appended a signature by default:

```
new session

Alice
alice@example.com
```

**Why it broke.** The command matcher required the whole (whitespace-stripped) body to *be*
the command. With two extra lines it was 30+ characters of text that merely *started* with
one — so it was treated as a task, not a command.

**Fix.** Strip the trailing signature block before matching. Two shapes are recognized:
the RFC 3676 separator (`-- ` on its own line) and the "name line + address line" tail that
most apps append.

**The deeper lesson.** The first version of the matcher was tested against strings written by
the same person who wrote the matcher. **Test with captured real input, not with input you
compose yourself.** The bug survived a whole evening of debugging because the unit tests were
green the entire time.

**Two sub-lessons that fell out of the fix:**

- The address group in the signature regex was written as `[^\s@\n]{1,64}@[^\s@\n]{1,64}`.
  The `{1,64}` after the `@` demands *at least one more character*, so a signature sitting at
  the very end of the string could not match at all. It must be `{0,64}`.
- The "line above the address" check required a **non-empty** line. But the most common
  signature shape is `body` / *blank line* / `address` — the line above is empty. The check
  therefore rejected exactly the case it was written for.

---

## 2. The permission fingerprint changed because the program wrote its own state file

**Context.** DSH reads its permission preset when a session is created; editing the config
never changes existing sessions. So the bridge records a fingerprint of the permission config
and rotates the session when it changes.

**Symptom.** The bridge announced "permission config changed" and wiped the conversation
memory **on every start**, even with nothing edited.

**Cause.** The fingerprint hashed each config file's content, its mtime, *and the mtimes of
three parent directories*. The session state file (`state.json`) lives in the project
directory. Writing it updated that directory's mtime — which was part of the fingerprint.
So the program kept detecting a change **that it had caused itself**.

**Fix.** Hash only the config files' content and their own mtimes. The file's own mtime still
changes when the file is replaced, so nothing meaningful is lost.

**The deeper lesson.** A change-detection signal must not be affected by the observer.
Include anything the program itself writes in its own fingerprint and you have built a
self-resetting alarm.

---

## 3. The error message was correct but unrecognizable

**Symptom.** A test asserting "unknown session is detected" failed. The output contained

```
error: unknown session id: session-x
```

and the detector was a regex looking for `unknown\s+id`.

**Cause.** `unknown session id` does not contain the substring `unknown id` — the word
`session` sits between them. The regex expected the DSH error format; the *mock* had been
given a slightly different, more descriptive wording.

**Fix.** Make the mock emit the same wording the real tool emits. A test double that
paraphrases the thing it is standing in for tests nothing.

**The deeper lesson.** When a detector and a producer are written by the same person, the
producer's wording tends to drift toward what reads nicely, while the detector encodes what
was actually observed. Pin the double to **captured real output**.

---

## 4. Every test that touched session state silently tested the wrong email

**Symptom.** In an end-to-end test, the second of two messages was reported as
"failed to parse", and the first was parsed twice.

**Cause.** The fake parser looked messages up by their `source` field — and the test helper
gave *every* message the same placeholder value `'raw'`. The lookup always returned the first
message, so both iterations used it.

**Fix.** Generate a unique `source` per message.

**The deeper lesson.** In a fake, **identity fields must stay unique**. A helper that
defaults every fixture to the same id turns "iterate over N items" into "process item 1,
N times" without any error being raised.

---

## 5. One bad email took down the whole batch

An outer `try` around the message loop meant a single exception skipped every remaining
message — and since messages are marked read before processing, the skipped ones were gone
for good. Each message now gets its own `try/catch`, and failures get an error reply.

## 6. An unhandled rejection killed the process quietly

Since Node 15, an unhandled promise rejection terminates the process by default. A bridge
that dies silently is worse than one that errors loudly: the user waits for a reply from a
process that no longer exists. Both `unhandledRejection` and `uncaughtException` are now
caught and logged.

## 7. Replies mailed themselves back

The bridge sends mail from the same address it reads. A reply landing in its own inbox, from
a whitelisted address, looks exactly like a new command. The result was an escalating chain
of self-replies, each one burning a real AI call.

Replies now carry a marker header (`X-Mail-Bridge-Bot`), and there is a fallback that
recognizes older replies by their signature block.

---

## 8. A task text limit that was actually a platform limit

Tasks used to be passed as a command-line argument. On Windows the command line caps out
around 32767 characters, and exceeding it fails with `E2BIG` — an error that says nothing
about length. Tasks are now written to the child process's **stdin**, which has no such
limit. The configurable `maxTaskChars` cap remains, but now it is a deliberate choice rather
than a workaround.

---

## 9. The leak was in the commit metadata, not the code

**Context.** Auditing this repository before publishing it, every tracked file was scanned
for personal data: real mailbox addresses, the SMTP auth code, local paths, the OS username.
All clean.

**What the scan missed.** The **commit authorship**:

```
a3c93d9 | author=<your-os-username> <<your-os-username>@localhost>
```

That is the operating-system account name. It was in no file — it came from `git config
user.name`, set from the OS account when the repository was initialized. It would have been
stamped on every commit and permanently visible on the public GitHub page.

**Fix.** Rewrite the authorship of every commit *before* the first push:

```bash
GIT_AUTHOR_NAME="YourName" GIT_AUTHOR_EMAIL="you@users.noreply.github.com" \
GIT_COMMITTER_NAME="YourName" GIT_COMMITTER_EMAIL="you@users.noreply.github.com" \
  git rebase --root --exec 'git commit --amend --no-edit --reset-author'
```

Setting the identity through environment variables overrides it for that one operation, so
the machine's global `git config` is left untouched.

**The deeper lesson.** When auditing for private data, **the payload is not the only place
data hides.** Metadata — authorship, timestamps, filenames, editor state — travels with the
artifact and is often more identifying than the content. A scan that only greps file
contents gives false confidence.

> **This section is its own example.** The first draft quoted the actual OS username, so the
> very document explaining the leak contained the leak — and the scanner caught it. Which is
> the point: a finding you write down is still a finding. Sanitize your incident reports too.

The script that checks both the files and the metadata lives at `scripts/privacy-scan.ps1`.

---

## A note on the permission-retry design

When a tool result shows an OS-level access denial, the bridge drops the session and retries
once in a fresh one. Two decisions there are deliberate:

**Retry once, never loop.** If a brand-new session is also denied, the cause is the
configuration, not a stale session. Looping would burn tokens and hide the real problem.

**Require both a phrase and an error code.** A model *saying* "permission denied" is a
statement, not evidence. Only raw OS errors from a tool result count. A false positive here
silently wipes the user's conversation, so the detector is tuned to miss rather than misfire.
