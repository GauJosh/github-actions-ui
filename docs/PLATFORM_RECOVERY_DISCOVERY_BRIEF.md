# Platform recovery discovery — review brief (optional organization context)

**Scope:** for an organization that wants to *run* recovery operations on its own infrastructure. That is an optional context, not the product's default audience.
- For maintainers of public and open-source repositories, the product's primary users, the recovery direction is a read-only **outage impact and catch-up view** (`docs/KUBERNETES_ACCESS.md` §4).
- Its next step is `docs/RECOVERY_VALIDATION_STUDY.md`.
- Share this brief only with an organization that asks to assess its own recovery tooling.

**Status:** brief prepared 2026-10-29. **No decision has been made, and no answers are recorded.**
- **This is a summary.** The source of truth is `docs/PLATFORM_RECOVERY_DISCOVERY.md` (the full checklist). Where they differ, the full checklist applies.
- **Record answers in the full checklist,** not here.
- Background and research: `docs/KUBERNETES_ACCESS.md` §7–§8.

## What we are trying to find out

GitHub Actions UI is a read-only investigation tool. It doesn't run, request or approve anything, and that won't change with this review.

The question here is separate: during a GitHub outage, can recovery operations (for example "redeploy a pinned release") be run safely? If so, where should that capability live (decision Q-R1)?

The review should establish which of these outcomes the evidence supports:
- **Existing platform tooling is sufficient** for the recovery operations that are actually needed (option PLATFORM).
- **A separate recovery capability is justified** (option SIBLING). This requires all of the following:
  - an agreed operation (its need and scope confirmed by the role in DA6);
  - a demonstrated gap in the existing tooling (a question that applies, answered `no`);
  - the tooling's owner (W4) can't close the gap;
  - no suitable alternative exists, such as another tool, a manual procedure, or narrowing the operation.

  Where existing tooling suits some operations but not others, the choice is a recorded judgement, not an automatic outcome.
- **No executor is needed,** because no recovery operation justifies its cost and risk.
- **Deferred,** because the evidence isn't there yet.

Placing recovery execution inside this repository is **not recommended**, and is considered only after a deliberate change to the project's purpose. All of these are proposals: **Q-R1, Q-R2, K-6, K-7, K-10, K-11 and every other architecture decision remain unapproved.**

## How to answer

- **Status:** `confirmed`, `partial`, `no` or `unknown`.
- **"Confirmed" needs evidence.** A verbal "yes" is `unknown` until it is shown.
- **Acceptable evidence:** an existing runbook, an architecture diagram, a drill or incident report, configuration reviewed in your own system, or a demonstration in a non-production environment.
- **Record where the evidence is and who showed it, not its contents.** This repository is public, so it must never receive credentials, tokens, keys, internal hostnames, account identifiers, incident details or personal data.
- **Answer per operation.** Not every question applies to every operation (full checklist §8–§9). Where answers differ by target, record them per target.

**How unknown answers are handled:**
- `unknown` means evidence is **missing**, not that a capability **failed**. It never counts against the existing tooling, and never justifies a new repository. The response is to gather the evidence, or to defer the decision.
- `partial` is treated like `unknown` until its gap is described. Then it is split into `confirmed` (what was shown) and `no` (the rest).
- `unknown` **does block authorization.** No operation runs against real targets until both hold:
  - every safety gate, and every question that applies to it, is `confirmed`;
  - the role identified in DA7 has authorized it.
- **Choosing existing tooling authorizes no operation by itself.** Operations with missing evidence stay blocked.

## Questions

IDs match the full checklist. *Gate* marks a proposed safety gate that every operation must meet before running against a real target.

**Existing tooling**

| ID | Question |
|---|---|
| T1 | Does recovery or break-glass tooling exist today? What is it, and who owns it? |
| T2 | Which recovery operations does it support? |
| T3 | Which targets, environments and clouds does it cover, and which are excluded? |
| T4 | Does it depend on GitHub Actions or self-hosted runners to execute? (Runners need GitHub to receive jobs) |
| T5 *(gate)* | Are operations versioned and immutable (pinned digests, signed bundles), or edited in place? |

**Complete GitHub outage** (github.com, its API, `ghcr.io` and GitHub's OIDC issuer all unavailable)

| ID | Question |
|---|---|
| G1 | Where do operation definitions and runbooks live, and are they readable without GitHub? |
| G2 | Are the images pulled by digest from a registry that doesn't depend on GitHub? |
| G3 | Are run-time packages and dependencies vendored or mirrored? |
| G4 | How do operations get credentials without GitHub OIDC, and are they short-lived? |
| G5 | Which external services must be reachable, and what happens if one is down? |
| G6 | Can the tooling itself be fixed and released during a GitHub outage? |
| G7 | Has recovery been exercised with GitHub deliberately unreachable? |

**Ownership and authority** (roles, not names)

| ID | Question |
|---|---|
| W1 *(gate)* | Which team owns each target? |
| W2 *(gate)* | Who owns, rotates and revokes the credentials or roles each operation uses? |
| W3 *(gate)* | Who is on call to request a recovery, and who to approve one? |
| W4 | Who owns the recovery tooling itself? |
| W5 | Is there an escalation path when only one approver is reachable? It must still keep the two-person rule (C1) |
| DA1–DA4 | Who decides Q-R1? Who approves K-6 and K-7? Would using existing tooling create a dependency that needs its own architecture decision? Where are these decisions recorded? |
| DA5–DA8 | Who may propose an operation? Who confirms its need and scope? Who authorizes real-target execution? Who may accept residual risk, and within what limits? |

These responsibilities may be held by different roles. One role may hold several only if that is recorded.

**Approval, audit, least privilege and rollback**

| ID | Question |
|---|---|
| C1 *(gate)* | Is two-person approval enforced **by the system**? A requester can create an execution only in a non-running (for example suspended) state, a **different** authorized person approves it, and it runs only after that approval. Group membership alone does not meet this |
| C2 *(gate)* | What audit record is kept (requester, approver, operation version, target, start, end, result)? Where, for how long, and can operators alter it? |
| C3 *(gate)* | Does each operation have its own identity with only the permissions it needs? |
| C4 *(gate)* | Is execution isolated from other workloads (namespace, network policy, no shared secrets)? |
| C5 *(gate)* | Does each operation have a tested rollback or a defined failure state? |
| C6 *(gate)* | Is a re-run safe, and are concurrent runs on one target prevented? (Kubernetes may start a Job's program twice) |
| C7 *(gate)* | Can anyone bypass approval: administrators, users who can impersonate a requester or approver, or anyone who can change the enforcing policy? Is bypass **prevented** or only **detected**? |

**Drills**

| ID | Question |
|---|---|
| DR1 *(gate)* | Has each operation passed a drill in a relevant **non-production** environment, for its target type and outage scenario? |
| DR2 | What recovery times were **measured**? Is there an agreed target, and who set it? |
| DR3 | Which drills failed or found gaps, and are those still open? |
| DR4 | Do operations expire or get disabled when drills lapse? |

An optional set of questions (P1–P5) about publishing a read-only status file for the UI is in the full checklist. It is a separate decision and is not needed for Q-R1.

## What counts for C7 and DR1

These are summaries. The full checklist §8 ("Gate evidence") governs.

- **C7 (bypass):**
  - *Prevented* (demonstrated) counts.
  - *Detected* counts **only** with a recorded risk acceptance naming:
    - the risk;
    - the detection and compensating controls, with evidence that they work;
    - the role that accepted it, which must hold that authority (DA8);
    - evidence of the acceptance.
  - Documenting detection alone is `partial`. Anything less is `unknown` and blocks authorization.
- **DR1 (drill):** the record must show all of the following:
  - the specific operation, at the version to be authorized, and the target type;
  - the outage scenario, or why the drill represents it;
  - the expected and observed results;
  - which of C1, C2, C5 and C6 were exercised. Those not exercised are listed, not assumed;
  - failures, limitations and open risks.

  A drill of another operation, target type or scenario doesn't count. DR1 sets no recovery-time target.

## What happens next

1. The platform team answers in the full checklist, with evidence references.
2. A per-operation record (full checklist §9) lists, for each proposed operation:
   - which questions apply and why;
   - their status;
   - what blocks authorization;
   - any gaps that matter to Q-R1.
3. The role identified in DA1 makes the Q-R1 decision using the full checklist's rules (§10), and records it with the template at the end of the full checklist.
