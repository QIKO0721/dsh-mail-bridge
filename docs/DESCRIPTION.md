# English descriptions

Copy-paste material for the GitHub repository page, README, and release notes.

---

## 1. GitHub "About" field (the short one)

GitHub allows roughly 350 characters here, but many views truncate nearer 120.
All of these fit; the first one is the recommendation.

**Recommended (110 chars):**

```
Send an email, your home machine does the work. A bridge between your inbox and DSH, for computers behind NAT.
```

**Also under 120 (interchangeable):**

```
Remote-control DSH over plain email. No public IP, no port forwarding, no tunnel service.
```
```
Turn a mailbox into a command channel for DSH. Outbound-only, so it works behind carrier-grade NAT.
```

**Longer version (130 chars — fits GitHub, may truncate in some list views):**

```
Email as a command channel for DSH - control the AI on your NAT-ed home machine from your phone. No public IP, no port forwarding.
```

> Note: prefer the plain ASCII hyphen over an em dash in this field. The em dash is fine in
> the README, but it costs three bytes in a field with a tight budget, and some clients
> render it inconsistently.

---

## 2. One-paragraph description (README intro / package description)

```
dsh-mail-bridge turns an ordinary mailbox into a command channel for DSH (DeepSeek Harness).
Send an email from your phone; a machine at home polls its own inbox over IMAP, hands the
body to DSH, and mails the result back. Because the machine only ever makes outbound
connections, it works from behind carrier-grade NAT — no public IP, no port forwarding, no
tunnel service, and no third-party relay to trust. Pure Node, three dependencies.
```

---

## 3. Full description (release notes / announcement)

```
dsh-mail-bridge — Email as a command channel for DSH
=====================================================

You have a computer at home. It has no public IP (typical broadband sits behind
carrier-grade NAT), so nothing outside can reach it. But it can reach out.

This is a bridge that uses that asymmetry. Your machine polls its own mailbox over IMAP.
You send an email from your phone. The body is cleaned, checked against an allowlist and
the provider's SPF/DKIM results, handed to DSH, and the answer is mailed back to you.

What it is not: it is not an AI. It contains no model of its own. DSH does the work; this
is the pipe.

Highlights
----------
* Outbound-only — works behind NAT, no port forwarding, no tunnel, no cloud account
* Three dependencies (imapflow / mailparser / nodemailer), pure Node, Node >= 18
* Conversation continuity — reuses a DSH session so "now change that script" works
* Loop-proof — replies carry a marker header and are never re-consumed as commands
* Anti-spoofing — allowlist, plus SPF/DKIM verification, plus an optional shared secret
* Quote and signature stripping — handles the reply formats of Gmail, Outlook, QQ, NetEase,
  and the "name + address" blocks that mail apps append automatically
* Permission self-healing — detects that a session is stuck on a stale DSH permission
  preset and transparently retries in a fresh one
* Backpressure — caps how many unread messages one poll cycle consumes, so a backlog
  cannot stall polling for hours
* Crash-resistant — one malformed email cannot take down the batch or the process

Testing
-------
495 assertions across 13 suites, plus an integration suite that runs against a real DSH
installation and skips cleanly when none is present. No mailbox and no DSH are required to
run the test suite: it ships a mock DSH that reproduces success, permission denial, unknown
session, timeout, and empty output, along with fake IMAP/SMTP layers. A separate static
audit scans the source for unresolvable requires, undefined exports, and anywhere a
credential could reach a log line.

Verified on Windows 11 with QQ Mail. Other platforms and providers are welcome as feedback.

Being honest about scope
------------------------
This program lets an email run commands on a computer. Read the security section before
deploying it, and read the caveat about the SPF assumption in particular — it is a provider
behaviour, not a protocol guarantee.

MIT licensed. Provided as-is.
```

---

## 4. Release notes for `v0.1.0`

```
v0.1.0 — first public release

Email as a command channel for DSH. Send an email; the AI on your NAT-ed home machine does
the work and replies.

Works behind carrier-grade NAT because every connection is outbound. No public IP, no port
forwarding, no tunnel service, no cloud account.

What's in it
  · IMAP polling with allowlist + SPF/DKIM verification (+ optional shared secret)
  · Quote and signature stripping, so auto-appended signatures don't break commands
  · DSH session continuity, with automatic recovery from a stale or missing session
  · Permission self-healing: detects a stale DSH permission preset and retries once in a
    fresh session, then says so in the reply
  · Loop protection via a marker header on replies
  · Backpressure cap so a mail backlog can't stall polling for hours
  · 495 assertions across 13 suites; a mock DSH and fake IMAP/SMTP mean the suite runs with
    no mailbox and no DSH installed

Verified on Windows 11 with QQ Mail. Feedback from other platforms and providers is very
welcome — several assumptions in here (notably how your provider marks externally-delivered
mail) are provider behaviours rather than protocol guarantees.

MIT licensed. Provided as-is.
```
