# Platform recovery discovery checklist (Q-R1) — optional organization context

**Scope:** this checklist is for an **optional context**: an organization that wants to *run* recovery operations on its own infrastructure. It is not the product's default audience, and nobody needs it to use the UI.
- The product's primary users are maintainers of public and open-source repositories. For them, the recovery direction is a read-only **outage impact and catch-up view** (`docs/KUBERNETES_ACCESS.md` §4).
- The next step for that direction is `docs/RECOVERY_VALIDATION_STUDY.md`.
- Use this checklist only if such an organization asks for it.

**Status:** checklist prepared 2026-10-29. **No answers are recorded yet.**
- **No decision has been made.** Q-R1, Q-R2, K-6 and K-7 remain open (`docs/KUBERNETES_ACCESS.md` §6–§8).
- **Nothing here describes existing platform tooling.** Every question is open until the platform team answers it with evidence.

**Purpose:** find out whether existing platform-team recovery tooling (option PLATFORM in KUBERNETES_ACCESS §8) is sufficient, before anyone proposes a new recovery repository (option SIBLING) or implementation.
- The Q-R1 assessment *recommends* against placing recovery execution in this repository (option IN-REPO, KUBERNETES_ACCESS §8.3). That is a recommendation, not a decision.
- The investigation UI has no part in requesting, approving or running recovery operations under any option.

**Question IDs:**
- T: tooling;
- G: GitHub outage;
- W: ownership;
- C: controls;
- DR: drills;
- P: optional status file;
- DA: decision authority.

These IDs are local to this checklist. In particular, DA and DR are not ARCHITECTURE's A-numbers or the project brief's D-numbers.

## How to use it

- **Answers:** each question is answered with a **status** and an **evidence reference**.
  - Status is one of: `confirmed`, `partial`, `no`, `unknown`.
  - "Confirmed" requires evidence. A verbal "yes" is recorded as `unknown` until it is shown.
- **Acceptable evidence:** an existing runbook, an architecture diagram, a drill or incident report, a configuration excerpt reviewed in the platform's own system, or a live demonstration in a non-production environment.
- **Handling rule:** record **where** the evidence is (title, owning team, system it lives in) and **who** showed it. Do not copy its contents. This repository is public, so never add any of the following to it:
  - credentials, tokens, secret values or keys;
  - internal hostnames or account identifiers;
  - incident details or personal data.
- **Scope:** not every question applies to every operation. §8 classifies the questions, and §9 records which ones apply to each proposed operation and why. Where answers differ by target, record one row per target.

---

## 1. Existing tooling and supported operations

| ID | Question | Evidence that answers it | Status | Reference |
|---|---|---|---|---|
| T1 | Does recovery or break-glass tooling exist today? What is it, and who owns it? | Tool documentation or a service catalogue entry naming the owner | | |
| T2 | Which recovery operations does it support (for example redeploy a pinned release, roll back, scale, fail over)? | Its list of operations, or runbooks per operation | | |
| T3 | Which targets, environments and clouds does it cover? Which are excluded? | Coverage list or architecture diagram | | |
| T4 | Does it depend on GitHub Actions or self-hosted runners to execute? (Runners need GitHub to receive jobs; KUBERNETES_ACCESS §7.2) | Architecture diagram showing the execution path | | |
| T5 | Are operations versioned and immutable (pinned image digests, signed bundles), or edited in place? | Release or versioning procedure; a sample manifest viewed in place | | |

## 2. Recovery during a complete GitHub outage

The worst case is O2 in KUBERNETES_ACCESS §7.2, where github.com, its API, `ghcr.io` and GitHub's OIDC issuer are all unavailable.

| ID | Question | Evidence that answers it | Status | Reference |
|---|---|---|---|---|
| G1 | Where do the operation definitions and runbooks live? Are they readable without GitHub? | Location of the mirror or store, shown being read with GitHub unreachable | | |
| G2 | Where do the images it runs live? Are they pulled by digest from a registry that doesn't depend on GitHub? | Registry location and a digest-pinned reference | | |
| G3 | Are the packages and dependencies it needs at run time vendored or mirrored? | Build or packaging procedure; a mirror configuration reviewed in place | | |
| G4 | How do operations get credentials without GitHub OIDC? Are they short-lived (for example cloud workload identity)? | Identity configuration reviewed in the platform's system; no credential values | | |
| G5 | Which external services must be reachable (identity provider, secret store, registry, cloud APIs)? What happens if one is down? | Dependency list or diagram | | |
| G6 | Is the tooling's own source, CI and release process able to ship a fix during a GitHub outage? | Description of its build path; a past example | | |
| G7 | Has recovery been exercised with GitHub deliberately unreachable? | Drill report or demonstration | | |

## 3. Targets, ownership and on-call

| ID | Question | Evidence that answers it | Status | Reference |
|---|---|---|---|---|
| W1 | For each target in scope, which team owns it? | Service catalogue or ownership record | | |
| W2 | Who owns the credentials or roles each operation uses? Who can rotate or revoke them? | Access-management record naming the owning team | | |
| W3 | Who is on call to request a recovery, and who to approve one? | On-call schedule or escalation policy, by role | | |
| W4 | Who owns the recovery tooling itself, including its maintenance and failures? | Ownership record | | |
| W5 | Is there an escalation path when only one approver is reachable? | Documented escalation procedure | | |

## 4. Approval, audit, least privilege and rollback

| ID | Question | Evidence that answers it | Status | Reference |
|---|---|---|---|---|
| C1 | Is two-person approval enforced **by the system**, not only by procedure? Specifically: requesters can create an execution only in a non-running (for example suspended) state, a *different* authorized person must approve it, and it runs only after that approval. (Group membership alone does not meet this; KUBERNETES_ACCESS §4.6) | Demonstration of the negative tests in KUBERNETES_ACCESS §7.5 that apply: self-approval, creation in a running state, and approval by a non-approver are each refused | | |
| C2 | What audit evidence is recorded (requester, approver, operation version, target, start, end, result)? Where, for how long, and can operators alter it? | A sample audit record viewed in place | | |
| C3 | Does each operation have its own identity, with only the permissions it needs? | Role or RBAC definitions reviewed in place | | |
| C4 | Is execution isolated from other workloads (namespace, network policy, no shared secrets)? | Configuration reviewed in place | | |
| C5 | Does each operation have a tested rollback or a defined failure state? | Runbook section and a drill showing it | | |
| C6 | Is running an operation twice safe, and are concurrent runs on one target prevented? (A Kubernetes Job can start a program twice; KUBERNETES_ACCESS §7.5) | Design notes or a drill that re-runs an operation | | |
| C7 | Can anyone bypass the approval gate: cluster administrators, users who can impersonate a requester or approver, or anyone who can change the enforcing policy? Is unauthorized bypass **prevented**, or only **detected**? If only detected, has the residual risk been accepted by someone with the authority to do so? (§8, gate evidence) | Prevention: a demonstration that bypass is refused. Detection: the alerting or audit-review procedure, a test showing a bypass is detected, and a residual-risk record (§8) | | |

## 5. Drills, recovery times and gaps

| ID | Question | Evidence that answers it | Status | Reference |
|---|---|---|---|---|
| DR1 | Has each operation passed a drill in a non-production environment relevant to the target type and outage scenario it is being authorized for? When? | A drill record with the contents listed in §8 (gate evidence) | | |
| DR2 | What recovery times were **measured** in those drills? Is there an agreed target, and who set it? | Drill reports; a documented objective with its owner | | |
| DR3 | Which drills failed or found gaps, and are those gaps still open? | Drill follow-up items and their status | | |
| DR4 | Do operations expire or get disabled when drills lapse? | Documented policy | | |

## 6. Optional read-only status artifact for the UI

This section applies only if displaying recovery readiness in the UI is wanted. That is a separate decision for the project maintainer (KUBERNETES_ACCESS §8.7, item 5). The UI would only read the artifact, with the user's own token, as it reads `.github/actions-ui-phases.yml` today: no backend, no new credential and no CSP change.

| ID | Question | Evidence that answers it | Status | Reference |
|---|---|---|---|---|
| P1 | Is a read-only status file wanted at all? By whom? | Stated need from the requesting team | | |
| P2 | Could it be published in a repository readable through the GitHub API (for example a small YAML or JSON file per operation)? | Agreement from its owner on location and format | | |
| P3 | What would it contain (operation, owner, pinned release, last drill, expiry), and is any of it sensitive? | Draft field list reviewed by the owner | | |
| P4 | Who updates it, and how is staleness shown? | Owner and update mechanism | | |
| P5 | Is it acceptable that it is unavailable during a GitHub outage, since the UI itself needs GitHub? | Owner's confirmation | | |

## 7. Decision authority

The project maintainer decides what this repository does (KUBERNETES_ACCESS §6). Authority over recovery operations, targets and risk belongs to the platform organization, and is what these questions establish.

| ID | Question | Evidence that answers it | Status | Reference |
|---|---|---|---|---|
| DA1 | Who has the authority to decide Q-R1 (where recovery execution lives), alongside the project maintainer's say over this repository? | Named role in a governance or ownership record | | |
| DA2 | Who approves K-6 (the recovery model) and K-7 (execution controls)? Are they the same people? | Named roles | | |
| DA3 | Does choosing PLATFORM create a dependency on another project that needs its own architecture decision? | Project boundaries confirmed with the project maintainer and the tooling's owner | | |
| DA4 | Where are Q-R1, K-6 and K-7 recorded, and who keeps them current? | Agreed location: ARCHITECTURE for anything that changes this repository, the owning location's records otherwise | | |
| DA5 | Who may **propose** a recovery operation? | Named role in an ownership or governance record | | |
| DA6 | Who **confirms** an operation's business or operational need and its scope, making it "agreed" under Q-R2? | Named role | | |
| DA7 | Who **approves the safety case** and **authorizes** execution of an operation against real targets? | Named role, and the record of where that authority comes from | | |
| DA8 | Who may **accept residual risk** (for example under C7), and within what limits? | Named role and the scope of its authority, from a governance record | | |

---

## 8. Question classes

The questions answer two different decisions, which must not be merged:
- **Q-R1:** where recovery execution lives.
- **Authorization:** whether a given operation may run against real targets. This belongs to K-7 and to the authority identified in DA7.

| Class | IDs | Applies to | Used for |
|---|---|---|---|
| **Safety gates** (mandatory) | T5, C1, C2, C3, C4, C5, C6, C7, W1, W2, W3, DR1 | **Every** operation, before it runs against a real target. The gates are proposals from KUBERNETES_ACCESS §7.5 and §7.9, not approved controls | Authorization of that operation. Also Q-R1, where a gate the tooling cannot meet for an agreed operation is a gap |
| **Operation-dependent** | T3, T4, G1–G7, W5, DR2, DR3, DR4 | Only where the operation's targets, outage scenarios or agreed objectives make them relevant (the table below) | Authorization of that operation, and Q-R1 gaps |
| **Operation ownership** | DA5, DA6, DA7, DA8 (with W1 and W2 for target and credential ownership) | Every proposed operation (§11) | DA5 and DA6 decide whether an operation is *agreed*, which Q-R1 rule 1 depends on. DA7 and, where a residual risk is accepted, DA8 are needed for authorization |
| **Repository-boundary evidence** | T1, T2, W4, DA1, DA2, DA3, DA4 | The Q-R1 decision as a whole | Q-R1 only |
| **Outside Q-R1** | P1–P5 | Only if the separate UI-display decision (KUBERNETES_ACCESS §8.7, item 5) is taken up | That decision only. Not needed for Q-R1 or authorization |

**Gate evidence** (proposed; **not approved**, pending review by the authority identified in DA2):

- **C7, bypass of the approval gate** (by administrators, by impersonation, or by changing the enforcing policy). Record exactly one of these states:
  - **Prevented:** unauthorized bypass is technically refused, and a demonstration shows the refusal. Record as `confirmed`.
  - **Detected, with recorded risk acceptance:** bypass is possible but is detected and audited. Record as `confirmed` **only** if a residual-risk record exists naming all of the following:
    - the risk (who can bypass, and how);
    - the detection and compensating controls, with evidence that detection works;
    - the role that accepted the risk, which must hold that authority under DA8;
    - evidence of that acceptance (the approval record, by reference).

    Documenting detection alone does **not** satisfy the gate. Without the acceptance record, the state is `partial`.
  - **Unknown or insufficient:** no evidence, or evidence that shows neither state. Record as `unknown` (or `partial`). This blocks authorization.
- **DR1, passing drill.** A drill counts for an operation only if its record shows all of the following:
  - **What was exercised:** the specific operation, at the version to be authorized (T5), and the **target type**.
  - **Scenario:** the outage scenario (O1, O2 or O3) it is being authorized to survive, or a stated reason why the drill is representative of it.
  - **Results:** the expected result, the observed result, and whether they matched.
  - **Gate checks:** the checks for the gates that apply to the operation, exercised in the drill:
    - approval separation (C1);
    - the audit record produced (C2);
    - rollback or the defined failure state (C5);
    - a safe re-run (C6).

    A gate the drill didn't exercise is listed, not assumed.
  - **Failures and limits:** any failures, limitations and unresolved risks.

  A drill of another operation, target type or scenario does not count. DR1 requires a **relevant non-production** environment, not a production drill. It sets **no** recovery-time target: measured times and any agreed objective belong to DR2. A passing drill shows the operation worked once under drill conditions. It does not make an untested gate enforceable.

**When operation-dependent questions apply:**

| ID | Applies when the operation… |
|---|---|
| T3 | …targets a system or environment whose coverage by the tooling isn't yet shown |
| T4 | …must run while GitHub Actions is unavailable (O1 or O2, KUBERNETES_ACCESS §7.2). That is the purpose of this work, so it is expected to apply almost always; any exclusion must be justified |
| G1, G2, G3 | …must run in O2 (definitions, images or dependencies would otherwise come from GitHub). G2 and G3 also apply in O3 if it pulls from GitHub-hosted registries |
| G4 | …needs credentials, and must run in O1 or O2, since GitHub issues its OIDC tokens to Actions jobs |
| G5 | …depends on any external service. Applies in every scenario |
| G6 | …may need a fix to the tooling itself during an outage (O1 or O2) |
| G7 | …must survive a scenario that has not yet been exercised. The drill must match that scenario |
| W5 | …may need approval outside working hours or with few approvers. The escalation path must still satisfy C1 |
| DR2 | …has an agreed restore objective. Without one, DR2 records measured times only |
| DR3 | …has had drills with recorded findings |
| DR4 | …has an agreed drill frequency and expiry window (KUBERNETES_ACCESS Q-R5) |

## 9. Per-operation record

Fill in one record per operation **proposed** under Q-R2 (by the role in DA5). This document names no operations. Placeholders such as `OP-1` are replaced by the proposer's own name for the operation.

```
Operation:            OP-1 (name given by its proposer)
Ownership (§11, roles only):
  Proposed by:        (DA5)
  Need and scope confirmed by: (DA6), date — the operation counts as "agreed" only after this
  Target owner:       (W1)    Credential owner: (W2)
  Safety case approved / execution authorized by: (DA7)
  Residual risk accepted by: (DA8), if any — with the risk record reference
Justification:        why this recovery need is worth its cost and risk (Q-R2)
Targets:              (systems and target types, by reference)
Scenarios:            O1 | O2 | O3   (which outages it must survive)
Drill evidence (DR1): drill record reference(s), matching this operation, target type and scenario

Applicable IDs:
  Safety gates:       T5 C1 C2 C3 C4 C5 C6 C7 W1 W2 W3 DR1   (always)
  Operation-dependent: (IDs from §8, each with the reason it applies)
  Excluded:           (operation-dependent IDs not applicable, each with the reason)

Evidence status:      ID: confirmed | partial | no | unknown — reference
Authorization blockers: safety-gate or applicable IDs not yet confirmed
Boundary gaps:        applicable IDs answered "no" for the existing tooling, each with
                      (a) whether the tooling's owner (W4) can close the gap, and
                      (b) the alternatives considered and why they are unsuitable
```

## 10. Decision rules

These are proposals, not approved policy. They apply the criteria of KUBERNETES_ACCESS §8.6 per operation.

**Evidence states:**
- `unknown` means evidence is missing, **not** that a capability failed. It can't justify rejecting the existing tooling or creating a repository. Either gather the evidence, or record the decision as deferred.
- `partial` is treated like `unknown` until its gap is described. Then it is recorded as `confirmed` for what was shown and `no` for the rest. C7 and DR1 have their own rules for when they count as `confirmed` (§8, gate evidence).

**Authorization** (per operation; the input to K-7, not part of Q-R1):
- An operation may be authorized against real targets only when all of these hold:
  - **every safety gate** and **every applicable operation-dependent question** is `confirmed` for the tooling that would run it;
  - the authorization is given by the role identified in DA7.

  Missing evidence blocks authorization; it is never treated as a pass.
- Any other state blocks authorization of **that operation only**. Other operations are unaffected.
- A residual risk counts as accepted only when the role identified in DA8 accepts it, within its authority, and the acceptance is recorded.

**Q-R1** (the repository boundary):
1. **Agreed needs first.** Only operations whose need and scope are confirmed by the DA6 role ("agreed" under Q-R2) count. If none justifies its cost and risk, the outcome is **no executor**, and a drift check is needed only if it is separately wanted.
2. **The existing tooling (PLATFORM) is sufficient for an operation** when T1 and T2 show that it covers the operation, and no applicable ID is `no`.
   - Unresolved `unknown`s don't count against PLATFORM, but they leave that operation's authorization blocked.
   - **Choosing PLATFORM on this basis authorizes no operation.** The decision record lists every operation still blocked, and why.
3. **A gap justifies a separate repository (SIBLING)** only if all of the following hold:
   - it is an applicable ID answered `no`;
   - for an agreed operation;
   - the owner of the existing tooling (W4) cannot or will not close it;
   - no suitable alternative exists, such as another existing tool, a manual procedure, or dropping or narrowing the operation.

   Gaps on non-applicable IDs, or on operations that aren't agreed, never count.
4. **Mixed results** (PLATFORM suits some operations, while others meet rule 3) must weigh the cost of running two mechanisms against narrowing the scope. The choice is recorded with its reasoning, not decided by these rules.
5. **IN-REPO** (this repository) stays out of scope unless the project maintainer first makes the product change described in KUBERNETES_ACCESS §8.6. That change is a prerequisite.
6. **Authority:** the decision is made by the role identified in DA1 and recorded where DA4 says. These rules support it; they do not make it.

## 11. Proposed ownership model (Q-R2)

These are **proposed responsibilities, not approved policy.** No roles, teams or people are assigned here. Each row is a question for the platform team (§7 and §3) until answered with evidence.

| Responsibility | What it covers | Answered by | Assigned to |
|---|---|---|---|
| **Propose** an operation | Raising a candidate recovery operation with its justification | DA5 | (unknown) |
| **Confirm need and scope** (sponsor) | Confirming the operation is worth its cost and risk, and fixing its scope, so it counts as agreed | DA6 | (unknown) |
| **Own the target** | The system the operation changes | W1 | (unknown) |
| **Own the credentials** | The roles or identities the operation uses, including rotation and revocation | W2 | (unknown) |
| **Approve the safety case and authorize execution** | Accepting the gate evidence (§8) and allowing real-target execution | DA7 | (unknown) |
| **Accept residual risk** | Accepting a risk that remains, such as detection instead of prevention under C7, within a defined authority | DA8 | (unknown) |
| **Request and approve a single execution** | Starting and approving one run of an authorized operation (two different people, C1) | W3 | (unknown) |

- **These can be different responsibilities.** Sponsoring an operation, owning its target, authorizing its execution and accepting its residual risk are separate questions. One role may hold several of them only if that is recorded.
- **Whether some must be held by different roles is open.** For example, whether the sponsor may also be the sole authorizer. Only the C1 separation (the person who requests an execution can't approve it) is part of the proposed gates.
- **The investigation UI has no part in this.** It does not propose, authorize, request, approve or execute anything (KUBERNETES_ACCESS §8.4).

---

## Q-R1 decision record (template)

Record the decision where DA4 says when one is made: ARCHITECTURE for anything that changes this repository, otherwise the chosen location's records. Until then it stays blank.

```
Decision: Q-R1 — where recovery execution lives
Date:
Status: proposed | accepted | rejected | superseded
Accountable owner (role):            # from DA1
Participants (roles):

Operations considered:               # §9 records, by operation name; operations rejected under Q-R2 and why
Evidence reviewed:                   # checklist IDs and references, no contents
Capabilities confirmed:              # per operation: applicable IDs with status "confirmed"
Gaps:                                # per operation: applicable IDs answered "no", whether the tooling's owner (W4) can close them, alternatives considered
Unknowns:                            # per operation: applicable IDs still "unknown" or "partial" (not counted as gaps)
Authorization blockers:              # per operation: unconfirmed safety gates; input to K-7, not part of this decision
Ownership:                           # per operation: DA5, DA6, W1, W2, DA7, DA8 roles (§11), or "unknown"
Residual risks accepted:             # risk record references and the DA8 role that accepted each; none is assumed

Decision:                            # PLATFORM, SIBLING, IN-REPO (only after the product change), none, or deferred
Rationale:                           # against the decision rules in §10 and KUBERNETES_ACCESS §8.6
Consequences:                        # for this repository, for the owning team, for K-6 and K-7; operations authorized: none until §10 is met

Follow-up actions (owner, due):
-
Review date:
```
