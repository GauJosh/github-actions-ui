# Recovery problem-validation study — plan

**Status:** study plan prepared 2026-10-29. **Desk research D-1 and D-2 was carried out on 2026-10-29 (§8). It was limited in scope.**
- **Signal feasibility (§4) was assessed on 2026-10-29 from code, fixtures and GitHub documentation (§9). Live unauthenticated probes on public repositories followed on 2026-10-30 UTC (§9.8).** **D-3, the maintainer interview study, is prepared (§5) but not started:** no participant has been recruited or interviewed. D-4 (registry desk research) has not been done. No feature is validated.
- **No feature is approved.** The study decides whether the capabilities in `docs/KUBERNETES_ACCESS.md` §4 are worth building.

**Audience:** maintainers of public and open-source GitHub repositories, the product's primary users. Organization-run infrastructure (Kubernetes, cloud, platform tooling) is an optional context (KUBERNETES_ACCESS §7–§8), not what the study is about.

**Notation:**
- **[O]** verified in this repository;
- **[V]** taken from GitHub documentation;
- **[A]** an assumption that the study must test;
- **[Q]** a question still to be answered.

---

## 1. What the study must answer

1. **Problems:** which problems do maintainers actually have when GitHub Actions or related services are unavailable, and how often? (The candidates in KUBERNETES_ACCESS §4.1 are all **[A]**.)
2. **Signals:** with the app's existing read-only access, can it reliably show:
   - failed and cancelled runs during a time window;
   - possible missed scheduled runs;
   - PRs waiting on checks;
   - any evidence of an infrastructure problem?

   And can it do so without claiming a cause?
3. **Value:** would a read-only **outage impact and catch-up view** save maintainers meaningful time or risk compared with GitHub's own pages and the status site?
4. **Later capability:** is a caveated **"release without Actions" preparation guide** wanted, and can it be made accurate enough not to mislead?

## 2. Starting facts

**Verified [O], from this repository:**
- The app requests only **Actions: Read, Contents: Read and Metadata: Read** (README). Whether Checks: Read and Pull requests: Read are needed is open question **Q2** (ARCHITECTURE §7.1).
- The app calls **no** pull-request, check-run, check-suite or annotations endpoints. It recognises runner annotations only as `##[error]`, `##[warning]` and `##[notice]` lines inside logs (`src/domain/logs/classify.ts`).
- The run list can already filter by event, including `schedule` (`src/ui/RepoDashboard.tsx`). The app already reads workflow files at a run's commit.
- The execution-graph model already has an `unknown` status (`src/domain/graph/build.ts`). The product rule is to show evidence, never a verified cause (ARCHITECTURE §1).
- The pinned fixture corpus (`fixtures.lock.json`) contains `workflow_dispatch`, `push` and `pull_request` runs, and **no** runs triggered by a schedule. Its run and job outcomes include `failure`, `cancelled`, `skipped` and `success`. A search found no infrastructure-failure messages in it. So it cannot yet test schedule gaps or infrastructure signals.
- The app keeps nothing between sessions (A4), and reads only GitHub's API. **It can show nothing while GitHub's API is unavailable.**

**From GitHub documentation [V]** (events that trigger workflows, `schedule`, read 2026-10-29: https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows):
- the `schedule` event "can be delayed during periods of high loads", and "some queued jobs may be dropped";
- "In a public repository, scheduled workflows are automatically disabled when no repository activity has occurred in 60 days";
- scheduled workflows "will only run on the default branch".

So a scheduled run that is absent is **not** evidence of an outage on its own. It must be shown as "possible missed run", cause unknown.

## 3. Desk research (D-1 and D-2 done 2026-10-29, see §8; D-4 to do)

| Item | Sources to consult | What to extract | Output |
|---|---|---|---|
| D-1. Incident history | GitHub's public status history (githubstatus.com) and published availability reports | Which components were affected (Actions, API, Git, Packages, Pages), how often, how long, and whether partial or complete | A dated table with a link for every incident counted, and the period covered |
| D-2. Maintainer discussions | Public issues and discussions in open-source repositories, the GitHub Community forum, and public maintainer write-ups about Actions outages | Which problems maintainers report (blocked releases, blocked merges, missed schedules, catch-up work, credentials tied to Actions), and what they did about it | Quoted excerpts **with links**, grouped by problem. No paraphrase presented as a quote |
| D-4. Publishing that depends on Actions (formerly D-3) | Public documentation of major package registries' "trusted publishing" and provenance features | Which publishing paths work only from Actions, and which fallbacks the registries document | A per-registry table with sources; nothing assumed for registries not checked |

Rules: record the search terms and the date. Count only what the sources show. Mark gaps as gaps.

## 4. Signal feasibility (assessed 2026-10-29, see §9; probes in §9.8 to do)

Assess each signal against **public repositories** and the fixture corpus, using only the existing read-only access unless a row says otherwise.

| Signal | How it might be established | Permission needed | What to measure | Status |
|---|---|---|---|---|
| S-1. Failed or cancelled runs in a window | Run list filtered by time and conclusion | Existing (Actions: Read) | Completeness (pagination, time filters); cost in requests | [A] feasible |
| S-2. Runs that never started, or started very late | Run and job states, and queue time (created vs started) | Existing | Whether these separate infrastructure delay from normal queueing; false positives | [A] partly feasible |
| S-3. Infrastructure evidence | Run conclusions such as `startup_failure`, runner errors in logs, missing runner information on jobs | Existing; logs on request | Which messages appear in real incidents, and whether any of them is specific enough to label (D-2 supplies examples) | **[Q] unknown** |
| S-4. Possible missed scheduled runs | The `cron` in the workflow file at the default branch, compared with runs whose event is `schedule` | Existing (Contents: Read, Actions: Read) | Tolerance for documented delays and drops; detecting disabled workflows; time zones (cron is UTC) | [A] feasible, always labelled "possible" |
| S-5. PRs waiting on checks | Open PRs, their head commit's check runs and statuses, and the base branch's required checks | **Beyond the current set** for private repositories (Pull requests, Checks, possibly Administration for protection rules). **[A]** Public-repository data may be readable with the existing token; to verify | Which data is readable without new permissions; whether required checks can be known without admin access | **[Q] unknown; depends on Q2** |
| S-6. Links for re-runs | Deep links to the run or job page on GitHub; the person re-runs there | None beyond existing | Link correctness for runs, attempts and jobs | [O] the app already links to GitHub |

**Fixture work:** add *synthetic* fixtures for schedule gaps and infrastructure-like failures only after D-2 shows real message patterns. Fixture changes need approval (ROADMAP rules).

## 5. D-3: maintainer interview study (prepared 2026-10-30; not started)

**Status:**
- **Prepared, not completed.** No participant has been recruited or interviewed, and no findings exist.
- This guide replaces the earlier draft questions in this section.
- (The registry desk research formerly labelled D-3 is now **D-4**, §3. It is unchanged and not started.)

**Purpose:**
- Test, from real past experience, whether catch-up after Actions disruptions costs maintainers meaningful effort. §8.4 found this not yet shown.
- Find out what information maintainers actually used, or lacked.
- The proposed view is tested only at the end, after the experience has been recorded.

### 5.1 Participants

- **Who:** 5–8 maintainers of public or open-source repositories that use GitHub Actions for CI or releases.
- **Spread to aim for** (recorded in the profile field, not by name):
  - project size: solo, small team, large;
  - runners: GitHub-hosted or self-hosted;
  - publishing or deployment: automated from Actions, or manual;
  - scheduled workflows, or none;
  - many fork PRs, or few.
- **Eligibility:** has maintained such a repository for at least the past 12 months.
  - Having experienced a disruption is **not** required.
  - "None" and "it didn't matter" are valid answers, and they guard against selection bias.
- **Consent:**
  - Participation is voluntary and can stop at any time.
  - Ask before taking notes, and again before any recording.
  - Notes are anonymized as participants P1…P8: no names, handles, employers or repository names.

### 5.2 What not to collect

- **Never request or accept:** tokens, secrets, credentials, private repository names, private logs, internal hostnames, incident tickets, or screenshots of private pages.
- **If a participant starts sharing one:** stop them, and record only "described a log or error (not collected)".
- **Public links** (for example a public issue or run): note one only if the participant offers it and agrees it can be stored. Store the link, not its content.
- **This repository holds nothing identifying.** Raw notes, if kept at all, stay outside it and are deleted once the summary is written.

### 5.3 Interviewer rules

- **Order matters:**
  - Parts A–C are about what happened.
  - Part D is about what they wish they had had.
  - Part E introduces the idea. **Before Part E, never mention the catch-up view, outages "being a problem", or this project's direction.**
- **Ask about the last specific occasion,** not general habits ("the last time…", "what did you do next?"). If the participant generalizes, ask for an example.
- **Don't suggest answers, examples or tools.** If the participant is stuck, give one example and record that you did.
- **Don't agree or praise.** Silence is fine.
- **Label every answer** as it is recorded (§5.5):
  - **E**, direct experience: something they did or saw, with a rough date;
  - **O**, opinion or belief;
  - **H**, hypothetical or preference ("I would…").
- **About 30–40 minutes.** Skip questions that don't apply, and record "not applicable" rather than a guess.

### 5.4 Guide

**Part A: experience (E)**
1. Have you had a time when GitHub Actions didn't work as expected for your project, for reasons you didn't cause? Tell me about the most recent one. Roughly when was it, and what happened?
   - If none: ask "What's the closest you've come?", then go to question 6.
   - Probes: How long did it last? Was it a one-off, or has it happened before?

**Part B: diagnosis (E)**

2. How did you work out whether the problem was in your workflow, your runner, or GitHub?
   - Probes: What did you look at first, and what settled it? How long did that take? Were you ever wrong about the cause?

**Part C: impact and catch-up (E)**

3. What couldn't you do while it lasted?
   - Probe each area that applies, without listing them first: PRs and merges, releases, publishing, scheduled jobs, deployments, contributors' PRs.
   - Probes: Did anything wait on you? Did contributors or users notice?
4. How did you find runs that were stuck, missing, or needed re-running?
   - Probes: How did you know you'd found them all? Did you miss any? How did you find out later?
5. What did you do after the service recovered?
   - Probes: What did you re-run, re-trigger or redo by hand? How long did it take? Was any work left half done, such as a partial release or a skipped scheduled job?

**Part D: needs (O or H; ask before showing any idea)**

6. Looking back, what information or tool would have saved you time?
   - If the answer is "nothing", record it, and don't probe for alternatives.

**Part E: the proposed view (H; introduce only now)**

Read this description exactly as written, without adding benefits:

> "A read-only page that, for one repository and a time window you choose, lists runs that are still queued or in progress and for how long, runs that failed or were cancelled with GitHub's own conclusion, and scheduled runs that may not have happened, each linking to GitHub. It doesn't say why something happened and can't re-run anything."

7. Would this be useful to you, and when? Which of that information, if any, would matter most?
   - Probe: What would you still have to do yourself?
   - Record "not useful" answers in full.
8. What would make a view like this misleading or untrustworthy?
   - Probes: What would make you stop using it? What would it need to say clearly?

**Close:**
- Ask: "Is there anything about your experience I didn't ask about?"
- Thank them, and confirm what will be recorded.

### 5.5 Evidence-recording template

- Fill in one copy per interview, from the notes, within 24 hours.
- Store it without identifying details.

```text
Interview: P<n>    Date: YYYY-MM-DD    Interviewer: <role, not name>    Duration: <min>
Consent: notes yes/no   recording yes/no   public links storable yes/no
Profile: size <solo/small/large>; runners <hosted/self-hosted/both>;
         publishing from Actions <yes/no>; scheduled workflows <yes/no>; fork PRs <many/few>
Examples prompted by interviewer: <none / which question>

| Q | Label (E/O/H) | Answer (participant's words or close paraphrase; direct quotes in "...") | When (approx.) |
|---|---|---|---|
| 1 |   |   |   |
| … |   |   |   |

Experience summary (E answers only):
- Disruption experienced: yes / no / unsure          Most recent: <month/year>
- Blocked: PRs / releases / publishing / schedules / deployments / none   (as stated)
- Catch-up actions taken: <as stated>               Time spent: <as stated, or "not stated">
- Something missed and found later: yes / no / not stated
- How the cause was determined: <as stated>

Reaction to the view (H, Part E only): useful / not useful / mixed / no opinion
Most important information named: <as stated>
Misleading or trust concerns: <as stated>

Interviewer observations (kept separate; not evidence of the participant's view):
-
Sensitive content declined: <none / "described X, not collected">
```

### 5.6 Analysis

- **Wait until all interviews are done,** then tally. Count participants, not mentions.
- **Evidence of the problem:** only **E** answers count as evidence that the problem exists or costs effort.
- **O and H answers** inform design and trust, never demand.
- **Report every tally, including the negative ones:**
  - no disruption experienced;
  - GitHub's pages and re-running were enough;
  - "not useful".
- **No percentages** at this sample size: "3 of 6", not "50%".

## 6. Evidence and decision criteria

**Proceed with the outage impact and catch-up view** only if all of these hold:
- **Problem:** D-1 and D-2, or the interviews, show that catch-up after Actions incidents recurs and costs maintainers effort. The evidence must be cited, and the threshold agreed before the research is analysed.
- **Signals:** S-1, S-4 and S-6 are reliable with the existing permissions. S-3 is shown only where evidence supports it, otherwise as `unknown`. S-5 is either feasible within the existing permissions for public repositories, or deferred to a separate Q2 decision.
- **Boundaries:** the design stays read-only, needs no new write or privileged credential, and adds no caching, persistence, backend, scheduler or executor.
- **Honesty:** every result can be presented as evidence with an explicit `unknown`, never as a stated cause.

**Investigate the "release without Actions" guide further** only if D-2, D-4 or the interviews (D-3) show the need. It would also need a way to present the guide's limits (KUBERNETES_ACCESS §7.3) so it can't be mistaken for a tested procedure.

**Stop or narrow** if:
- the problems don't recur;
- GitHub's own pages already answer them;
- the signals would mislead more often than help.

## 7. Outputs

- A dated findings document with sources for every claim, keeping verified findings, assumptions and open questions apart.
- A recommendation for the project maintainer: build, narrow, defer or drop each capability. It is recorded in ARCHITECTURE only if a decision is made.

---

## 8. Desk research results: D-1 and D-2 (2026-10-29)

**Method:**
- Web searches on 2026-10-29 for GitHub availability reports, githubstatus.com incidents, GitHub Community discussions, news coverage and maintainer write-ups about Actions outages.
- Each source listed below was **opened and read**. Search-result summaries were not used as evidence.
- **Primary** means GitHub's own reports or first-hand posts. **Secondary** means news reporting.
- Aggregator and status-mirror sites were not used as evidence.
- Each incident is counted **once**, however many sources describe it.

### 8.1 D-1: GitHub incidents affecting Actions (primary sources)

| # | Date (UTC) | Duration | Affected | Reported impact (as GitHub states it) | What GitHub says customers had to do afterwards | Source |
|---|---|---|---|---|---|---|
| I-1 | 2026-02-02 | — | Actions hosted runners | "Major outage"; runner lifecycle operations halted | — | [GitHub CTO, 2026-03-11](https://github.blog/news-insights/company-news/addressing-githubs-recent-availability-issues-2/) |
| I-2 | 2026-03-05 | — | Actions job orchestration | A Redis failover left no writable primary; fixed manually | — | same |
| I-3 | 2026-07-09 | 9h18m | Hosted runners, Pages builds, Copilot jobs | ~8% of hosted-runner runs delayed >5 min; ~2% failed to start | — | [Availability report, July 2026](https://github.blog/news-insights/company-news/github-availability-report-july-2026/) (published 2026-08-12) |
| I-4 | 2026-07-19 | 5h10m | Self-hosted and larger runners | 9% of runs had a start delay, peaking at 21.4% | — | same |
| I-5 | 2026-07-19 | 2h11m | github.com including Actions and webhooks | Peak regional 5xx rate 9.9%; webhooks interrupted ~40 min in one environment | — | same |
| I-6 | 2026-07-25 | 52 min (two periods) | Actions job assignment | At peak, 60% of runs "failed with an infrastructure error"; 30% delayed >5 min | — | same |
| I-7 | 2026-08-06 | ~9–10.7 h (the report gives both) | Hosted and self-hosted runners, Pages, Dependabot, Copilot | ≥74 organizations had runs fail to start, fail partway, or stay queued | Re-running "usually succeeded". Some self-hosted runners were recovered manually. Some events "could not be replayed automatically" and had to be re-triggered | [Availability report, August 2026](https://github.blog/news-insights/company-news/github-availability-report-august-2026/) (2026-09-09); [incident thread #204152](https://github.com/orgs/community/discussions/204152) |
| I-8 | 2026-08-17 | ~6h44m–7h35m | APIs, issues, PRs, Actions, webhooks API | 56.07% of front-door requests failed or were slow at peak; ~29K organizations | Retrying often worked | August 2026 report |
| I-9 | 2026-08-26 | ~2h50m | Actions run starts, Pages, Copilot review | "more than one in five" run starts failed or badly delayed; 386 organizations | Failed runs succeeded when re-run. Runs created early "had to be started fresh". Some runs stayed showing as queued | August 2026 report |
| I-10 | 2026-09-13 | ~1.5–2 h | Starting workflows, plus issues, PRs, tokens | ~4% of workflows had intermittent failures | — | [Availability report, September 2026](https://github.blog/news-insights/company-news/github-availability-report-september-2026/) (2026-10-14) |

**Secondary only (not counted above):**
- *2026-05-26*, Actions and Pages authentication failures: GitHub's incident updates said "the majority of Actions runs" were affected, from about 10:57 to 13:18 UTC. Reported by [The Register, 2026-05-27](https://www.theregister.com/devops/2026/05/27/github-actions-outage-told-devs-your-account-is-suspended/5246867); the May availability report was not read.
- *2026-10-01* and *2026-10-05:* seen only in search summaries; not verified.

**Excluded as not relevant to public repositories:** 2026-07-08, which affected data-resident Enterprise Cloud environments only.

**Facts established [V]:**
- The three monthly reports read (July to September 2026) describe **8 incidents affecting Actions** on github.com (I-3 to I-10).
- Several lasted multiple hours (I-3, I-4, I-7, I-8, I-9).
- After I-7 and I-9, GitHub itself says customers had to **re-run failed workflows, re-trigger runs whose events were never processed, or start runs fresh**, and that some runs stayed shown as queued.
- GitHub uses the category "failed with an infrastructure error" (I-6).

### 8.2 D-2: maintainers' and users' experiences

| # | Date | Source (type) | Documented facts | Interpretation, and its limits |
|---|---|---|---|---|
| M-1 | 2026-05-23 to 2026-08-07 | [Community discussion #196717](https://github.com/orgs/community/discussions/196717) (first-hand, 12 participants) | Runs stuck in "Queued" that could not be cancelled; force-cancel returned HTTP 500, 409 or 403. A merged PR's run stayed queued; a Pages deployment stayed queued until it timed out. Participants linked it to GitHub outages (May; "the outage yesterday" on Aug 7). The accepted answer points to a Support ticket whose content isn't visible | Supports "is it GitHub or me?" and catch-up after outages. Mixed audience (not only open source). The cause is the participants' attribution, not GitHub's confirmation |
| M-2 | 2026-08-06 onwards | [Incident thread #204152](https://github.com/orgs/community/discussions/204152) (GitHub announcement, 24 participants) | Recovery steps: delete stuck ARC pods or redeploy, re-run, or push a new commit, because events "cannot be replayed automatically". Users kept reporting stuck runs after resolution, with one report on 2026-10-01 | The same incident as I-7, so **not independent evidence of recurrence**. Shows that catch-up work continued after resolution |
| M-3 | undated | [pdelie CI troubleshooting guide](https://pdelie.readthedocs.io/en/stable/releases/CI_TROUBLESHOOTING.html) (an open-source project's runbook) | For a 503 during action download: check the status page; if an incident is open, "that is the confirmed cause"; re-run the failed jobs (`gh run rerun --failed`); don't force-push; don't disable the check | **Counter-evidence:** this project handles outages with the status page plus re-runs, which existing tools already allow. One project only |
| M-4 | 2026-01-26 onwards | [Community discussion #185355](https://github.com/orgs/community/discussions/185355) (first-hand) | Scheduled workflow not running. The causes discussed were load delays, default branch, UTC and inactivity; **no outage was confirmed**. An accepted fix (push a commit) didn't work for the poster. One user switched to an external cron calling `workflow_dispatch` | **Counter-evidence for attribution:** missing scheduled runs happen without an outage, and their causes are often unclear. "Possible missed scheduled run" must never imply an outage |
| M-5 | 2026-05-27 | [The Register](https://www.theregister.com/devops/2026/05/27/github-actions-outage-told-devs-your-account-is-suspended/5246867) (news) | During the 2026-05-26 incident, runs failed with a misleading "Your account was suspended" error. One person responsible for a company CI team said CI was "basically blocked" | Supports "is it GitHub or me?". The quote is from a company, not an open-source maintainer |
| M-6 | 2026-08-06 | [The Register](https://www.theregister.com/a/5284297) (news) | Reports a well-known open-source maintainer saying GitHub is no longer a place for "serious work". Secondhand; it doesn't say whether Actions was the reason | Shows reliability concern among maintainers. **Not** evidence of a catch-up need |

**Searched for but not found:**
- an open-source project announcing a release delayed or postponed because of an Actions outage;
- a maintainer's first-hand write-up of catch-up work after an outage.

Absence in a limited search isn't evidence of absence, but it means the **cost to maintainers is not yet documented**.

### 8.3 Limitations

- **Period:** the incident count covers July to September 2026 (three reports) plus two earlier incidents from GitHub's March post. Other months weren't read, so this is **not** an annual count. The reports measure impact in organizations and percentages, not specific repositories.
- **Not about open source specifically:** GitHub's reports don't say which incidents hurt public repositories most.
- **Few first-hand maintainer sources:** two Community threads with mixed audiences, one project runbook, and news quotes. No interviews have been held.
- **Search:** web search on one day, in English, without access to private channels or chat platforms.
- **Attribution:** user posts link failures to outages. This study records that as their attribution unless GitHub confirms it.

### 8.4 Preliminary assessment (not a decision)

- **Recurring: supported.** Incidents affecting Actions recur, with 8 in three months of 2026 per GitHub's own reports, several lasting hours. GitHub itself describes post-incident catch-up work: re-running, re-triggering events that were never processed, starting runs fresh, and clearing runs stuck as queued (I-7, I-9).
- **Meaningful to open-source maintainers specifically: not yet shown.** The evidence of cost to maintainers is thin. One project's runbook suggests the status page and re-running are enough for simple cases (M-3).
- **Implications for the view, if pursued:**
  - The most distinctive need in the evidence is finding what **didn't run or stayed stuck**: runs whose events were never processed, runs stuck as queued, possible missed schedules. Simply listing failures is less distinctive, since GitHub's UI already shows them.
  - That makes signals S-2, S-4 and S-5 and the detection of *absent* runs the critical feasibility questions.
  - It also makes honest labelling essential: M-4 shows that missing runs happen without outages.
- **Outside the view's read-only scope:** cancelling stuck runs, and fixing self-hosted runner controllers (M-1, M-2). The view could at most point people to GitHub.

### 8.5 Recommendation

**Proceed to API signal feasibility (§4).**
- The recurrence of the problem is established from primary sources.
- More desk research is showing diminishing returns: public first-hand maintainer accounts are scarce.
- The decisive open question is whether read-only access can reliably find stuck, absent and possibly missed runs without implying a cause. Feasibility work can answer that cheaply, or rule the idea out.
- Whether maintainers value the view still needs the interviews (§5) before any build decision (K-10).

---

## 9. Signal feasibility results (2026-10-29)

**Method:**
- Read the app's GitHub client (`src/github/client.ts`), domain types and conclusion sets (`src/domain/types.ts`), `src/domain/graph/build.ts`, `src/domain/insights/retry-evidence.ts`, the log classifier (`src/domain/logs/classify.ts`) and the run filters in `src/ui/RepoDashboard.tsx`.
- Scanned the pinned fixture corpus (`fixtures.lock.json`, commit `184ede0`) with a throwaway script kept outside the repository. Searched the synthetic fixtures in `tools/fixture-server/`.
- Read GitHub's REST documentation, cited per item (all read 2026-10-29).
- No live API calls were made for §9.1–§9.7. Questions the documentation didn't settle were marked **[Q]**, then probed live (§9.8); the markers below now point to those results.
- Nothing was implemented, and no permission was changed.

### 9.1 What the app reads today [O]

| Endpoint (all GET) | Used for | Fields relevant here |
|---|---|---|
| `/repos/{o}/{r}/actions/workflows` | Workflow list | `id`, `name`, `path`, `state` |
| `…/actions/runs` and `…/actions/workflows/{id}/runs` | Run list, 25 a page | Filters used: `status`, `branch`, `event`, workflow. **`created` (time window) and `head_sha` are not used** |
| `…/actions/runs/{id}` and `…/attempts/{n}` | One run or attempt | `status`, `conclusion`, `event`, `created_at`, `run_started_at`, `updated_at`, `run_attempt`, `pull_requests`, `head_sha`, `head_branch` |
| `…/actions/runs/{id}/jobs` (and per attempt) | Jobs | `status`, `conclusion`, `created_at`, `started_at`, `completed_at`, `runner_name`, `labels`. `runner_group_name` is returned but isn't in the `Job` type |
| `…/actions/jobs/{id}/logs` | Logs | `##[error]`, `##[warning]` and `##[notice]` lines; failure signatures |
| `…/contents/{path}?ref=` | Workflow file at a commit | `on.schedule` cron lines could be read from it |
| Approvals, pending deployments, deployments, releases, tags, artifacts, compare | Other evidence | Not relevant to these signals |

**Not called:** pull requests, check runs, check suites, check-run annotations, commit statuses, branch protection, rulesets, repository events, runners.

### 9.2 Fixture corpus facts [O]

- **Pinned corpus:** 34 runs, **all `workflow_dispatch`** and all `completed` (20 success, 12 failure, 2 cancelled). 55 jobs, all on GitHub-hosted runners: `runner_group_name` "GitHub Actions", labels `ubuntu-latest` or `windows-latest`.
- **Timing:**
  - Job queue time (`started_at − created_at`) is at most 7 s.
  - One run shows 204 s between `created_at` and `run_started_at`. It is **attempt 2**: `created_at` keeps the original run's time, and `run_started_at` is the attempt's start. That is a built-in false positive for any "late start" rule.
  - Both skipped jobs have `runner_name: null` and `started_at` equal to `created_at`.
- **Annotations:** the fixture repository holds 78 check-run annotations (49 notice, 2 warning, 27 failure), keyed by job ID.
  - Examples: "Process completed with exit code 1.", "The job has exceeded the maximum execution time of 1m0s", "The operation was canceled.", "Canceling since a higher priority waiting request … exists".
  - **The app and fixture server neither serve nor use them.** None describes an infrastructure fault.
- **Synthetic fixtures:**
  - What exists: one schedule-event graph (`990000104`, a single run with no cron); queued, waiting and in-progress jobs; `startup_failure` in unit tests only.
  - What's missing: a run history over time, a schedule series, a stuck-queued run, a self-hosted runner, and an infrastructure-error message.
- **Correction to §2:** the event and conclusion counts quoted earlier included synthetic fixtures. The pinned corpus has no `push` or `pull_request` runs.

### 9.3 Results by signal

#### Signal 1: stuck or queued runs (S-2)

- **Evidence:**
  - Run `status` is one of `queued`, `in_progress`, `waiting`, `requested` or `pending`, and the run list can filter on it ([workflow-runs docs](https://docs.github.com/en/rest/actions/workflow-runs)). The app already passes `status`.
  - Runs have `created_at`, `run_started_at`, `updated_at` and `run_attempt`. Jobs have `created_at`, `started_at`, `runner_name` and `labels` (`src/domain/types.ts`).
  - Documented [limits](https://docs.github.com/en/actions/reference/limits): a self-hosted job "can be in the queue for 24 hours before it is automatically cancelled", and a run is cancelled at 35 days.
- **Safe conclusion:** "This run or job has been `queued` for *N* minutes as of now, with no runner assigned." That is a timestamped fact. "Longer than usual for this workflow" is safe only as an explicit comparison with the same workflow's recent runs.
- **False positives and unknowns:**
  - **Normal waits look the same:** `pending` from concurrency groups, `waiting` on environment approvals (the app already reads pending deployments), offline or busy self-hosted runners, and larger-runner capacity.
  - **Re-runs:** a run's `created_at` belongs to the original run (fixture `39365979905`). Queue time must use job `created_at` or the attempt's `run_started_at`.
  - **Stale status:** GitHub's own report says some runs "stayed showing as queued" after I-9, so `queued` may be wrong, not just slow.
  - **No fixed threshold:** there's no defensible one. A baseline needs a history fetch, because nothing is kept between sessions (A4).
  - **Probed (§9.8 P-3):** on a queued job `started_at` **equals** `created_at`, and the run's `run_started_at` equals its `created_at`. Time in queue must be "now − `created_at`".
- **Current permissions:** yes (Actions: Read).
- **Missing fixtures and tests:**
  - a run stuck `queued` with no jobs;
  - a queued job with `runner_name` null, on a hosted runner and on a self-hosted one;
  - concurrency `pending`;
  - a re-run attempt with a large `created_at` gap;
  - a status left `queued` after it should have resolved.
- **Classification:** partially feasible. Age-in-state is reliable; "unusual" is not; the cause stays `unknown`.

#### Signal 2: failed or cancelled runs, and infrastructure evidence (S-1, S-3)

- **Evidence:**
  - Run and job `conclusion`. The run list's `status` filter accepts conclusions such as `failure`, `cancelled`, `timed_out`, `startup_failure` and `action_required`.
  - The app already treats those as not successful (`src/domain/types.ts`), and keeps `startup_failure` as reported (`retry-evidence.ts`).
  - Log `##[error]` lines and failure signatures (`classify.ts`), one log download per job.
  - Check-run annotations exist per job (via `check_run_url`) but are **not read** by the app.
- **Safe conclusion:** "*N* runs in this window concluded `failure`, `cancelled`, `timed_out` or `startup_failure`", with links to GitHub, where people re-run (S-6).
- **Window query:**
  - The run list accepts a `created` date range, but returns "up to 1,000 results for each search" when filtered ([workflow-runs docs](https://docs.github.com/en/rest/actions/workflow-runs)). That is about 10 requests of 100 per filter per window.
  - A larger window is incomplete and must say so.
- **Infrastructure attribution is not reliable:**
  - `startup_failure` also comes from invalid workflow files and permissions.
  - `cancelled` also comes from concurrency and from users. The fixtures contain "Canceling since a higher priority waiting request".
  - GitHub's "failed with an infrastructure error" category (I-6) isn't an API field.
  - No real infrastructure-error message has been captured (§9.2).
  - Lining failures up with the status page would need outside calls, which are out of scope.

  The cause therefore stays `unknown`.
- **Current permissions:** conclusions and logs, yes. Annotations would need the Checks API (signal 5 table).
- **Missing fixtures and tests:**
  - `startup_failure` with no jobs;
  - `timed_out`;
  - a run whose jobs never got a runner;
  - a real runner message, captured from a cited public source;
  - a window over the 1,000-result cap.
- **Classification:**
  - Listing outcomes in a window: feasible.
  - Identifying infrastructure causes: not feasible; the cause stays `unknown`.

#### Signal 3: possibly missed scheduled runs (S-4)

- **Evidence:**
  - `on.schedule` cron lines in the workflow file at the default branch (Contents: Read; the app already reads files at a commit).
  - `event=schedule` runs for that workflow, with `created_at`.
  - Workflow `state`, whose values include `disabled_inactivity` and `disabled_manually` ([workflows docs](https://docs.github.com/en/rest/actions/workflows)), so documented disabling is directly visible.
- **Safe conclusion:**
  - "About *K* scheduled runs were expected between A and B from this cron, and *J* were found. Gaps at … are **possible missed runs, cause unknown**."
  - "This workflow is disabled (inactivity)", read directly from `state`.
- **Limitations:**
  - **Documented delays and drops** (§2) require a tolerance. Any value is **[A]** until checked against real history.
  - **The schedule may have changed:** the cron at the branch head may not be the one that was in force. Reconstructing it needs the file's commit history and more requests.
  - **Disabling and re-enabling** leave no trace in `state`.
  - **The default branch may have changed.** Scheduled runs happen only on the default branch.
  - **Matching is complicated** by cron being UTC, by several cron lines, and by `workflow_dispatch` runs that stand in for a schedule.
  - **Forks** disable schedules (`disabled_fork`).
  - **"Never triggered" and "triggered then dropped before a run existed"** look the same.
  - **M-4** shows gaps without outages, so an outage must never be implied.
- **Current permissions:** yes (Actions: Read, Contents: Read).
- **Missing fixtures and tests:** none exists for any of these:
  - a schedule series with regular runs and one gap;
  - late runs inside and outside the tolerance;
  - a cron change mid-window;
  - a `disabled_inactivity` workflow;
  - several cron lines.
- **Classification:** partially feasible. Labelled "possible missed run" only, never confirmed.

#### Signal 4: events or runs that never appeared

- **Evidence:** none direct.
  - No endpoint lists events that GitHub received but never turned into runs.
  - Webhook delivery logs cover only the repository's own webhooks, and need admin access.
- **Indirect options, and their limits:**
  - **Commits without a run:** compare a branch's commits (Contents: Read) with runs by `head_sha`.
    - A push runs only for its head commit.
    - `paths`, `branches` and `[skip ci]` legitimately skip runs.
    - Push boundaries aren't visible from commits.
  - **Repository events API:** lists pushes with heads, but GitHub's [events docs](https://docs.github.com/en/rest/activity/events) say it "is not built to serve real-time use cases".
    - Latency is "30s to 6h".
    - At most 300 events are returned, from the past 30 days only.
    - Its fine-grained permission isn't stated there. **Probed (§9.8 P-4):** readable without permissions on a public repository; the private-repository permission is unresolved.
  - **Evaluating `on:` filters** faithfully would mean re-implementing GitHub's trigger logic, with a risk of confident wrong answers.
- **Safe conclusion:** at most "no run found for push head X on branch Y in the window; workflow filters not evaluated". **Detecting events that were never processed is fundamentally unobservable** from read-only API data. GitHub's incident reports (I-7) are the only source that says it happened.
- **Current permissions:** commits and runs, yes. The events API is readable on public repositories (§9.8 P-4).
- **Missing fixtures and tests:** push heads with and without runs; path-filtered skips; `[skip ci]`; multi-commit pushes.
- **Classification:** not feasible as detection. The weak "push head with no run" hint isn't recommended.

#### Signal 5: PRs waiting on required checks (S-5)

- **Current calls:**
  - Runs carry `event` `pull_request` and `pull_requests` (numbers only). So the app can list PR-triggered runs that are queued or failed.
  - It **can't** tell whether the PR is open, which checks are **required**, or the state of third-party checks and statuses.
  - **Probed (§9.8 P-2):** `pull_requests` is empty on runs from fork PRs (25 of 25 sampled), the common case in open source.
- **Other data the full signal would need:**

  | Data | Endpoint | Fine-grained permission ([permissions page](https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens)) | In the current set? |
  |---|---|---|---|
  | Open PRs and head SHAs | `GET …/pulls` | Pull requests: Read | **No** |
  | Classic required checks | `GET …/branches/{b}/protection/required_status_checks` | Administration: Read | **No** (and admin is unsuitable for a read-only viewer) |
  | Ruleset required checks | `GET …/rules/branches/{b}` | Metadata: Read | **Yes**, but covers rulesets only |
  | Commit statuses (external CI) | `GET …/commits/{ref}/status` | Commit statuses: Read | **No** |
  | Check runs per commit | `GET …/commits/{ref}/check-runs` | Not listed on the permissions page. The [check-runs docs](https://docs.github.com/en/rest/checks/runs) name only the classic `repo` scope, for private repositories | **Public repositories: readable without permissions** (§9.8 P-1). Private: unresolved |

  The permissions page says "Some endpoints can also be used to access public resources without these permissions", to be checked per endpoint. **Probed (§9.8 P-1):** on a public repository, PRs, check runs, annotations, commit statuses and rulesets returned 200 unauthenticated. Classic protection returned 401, but its required check names appear on the branch object. The table above holds for private repositories.
- **Safe conclusion with current access:** "PR #N's run for head X is `queued` (or failed)". **Not** "PR #N is blocked on required checks".
- **Current permissions:** no, for the full signal. Not expanded here; this stays open question **Q2**.
- **Missing fixtures and tests:** a fork-PR run with empty `pull_requests`; a ruleset response; check runs and statuses for a head commit.
- **Classification:** not feasible with current access. A partial list of "PR-triggered runs needing attention" is possible.

#### Signal 6: self-hosted runners

- **Evidence:** job `labels` (including `self-hosted`), `runner_name`, `runner_group_name` (returned but not typed), `status` and `started_at`.
- **Safe conclusion:**
  - "This job requested labels [`self-hosted`, …] and has been queued *N* minutes with no runner assigned."
  - "This job ran on runner R in group G."
- **Cannot be inferred:**
  - **Runner and controller health:** whether a matching runner is registered, online or busy, or whether a controller (for example ARC, M-2) is healthy. Listing runners requires "admin access to the repository" ([self-hosted runners docs](https://docs.github.com/en/rest/actions/self-hosted-runners)) and Administration: Read, which are out of scope.
  - **Runner type from labels:** larger GitHub-hosted runners use custom labels without `self-hosted`, so classifying by label is unreliable. Confirmed in §9.8 P-3: queued self-hosted-style jobs carried custom labels without `self-hosted`.
  - **Where a delay comes from:** a self-hosted queue can't be told apart from a GitHub-side assignment fault.
- **Current permissions:** partly; job-level facts only.
- **Missing fixtures and tests:** self-hosted and larger-runner jobs queued with no runner; a job auto-cancelled at the 24-hour queue limit. The corpus has none.
- **Classification:** partially feasible, at job level only.

### 9.4 Cross-cutting limits

- **Catch-up only:** the app reads only GitHub's API and keeps nothing (A4). Every signal serves the period after an outage, not the outage itself.
- **Baselines:** "unusual" queue times and schedule tolerances need earlier runs, fetched again each session because there is no caching.
- **Request cost:**
  - Filtered run searches stop at 1,000 results.
  - Jobs cost one request per run, so a 100-run window needs about 100 job requests or more.
- **Unclear access:** check runs, the events API and permission-free public access all need probes (§9.8).

### 9.5 Summary

| Signal | Classification | Basis |
|---|---|---|
| 1. Stuck or queued runs | **Partially feasible** | Age-in-state is reliable. "Unusual" needs a per-workflow baseline. Cause always `unknown` |
| 2a. Failed or cancelled runs in a window | **Feasible** | Conclusions plus a `created` window, capped at 1,000 per search |
| 2b. Infrastructure cause | **Not feasible with current access** | No API field; conclusions are ambiguous; no messages captured |
| 3. Possibly missed scheduled runs | **Partially feasible** | Cron, `schedule` runs and workflow `state`. Always "possible"; cron history and tolerance limit it |
| 4. Events or runs that never appeared | **Not feasible with current access** | No such endpoint; indirect hints don't evaluate triggers |
| 5. PRs waiting on required checks | **Private repositories: not feasible with current access. Public repositories: partially feasible (§9.8 P-1)** | Private: needs Pull requests, Commit statuses and Administration or Checks. Public: PRs, check runs, statuses and required check names (via the branch object) readable without permissions, untested with the app's own token. Not expanded (Q2) |
| 6. Self-hosted runners | **Partially feasible** | Job labels and runner fields only. Runner health needs admin |
| S-6. Links to re-run | **Feasible** [O] | The app already links to GitHub |

### 9.6 Smallest useful read-only capability the evidence supports

A **"since a time" catch-up list** for one repository. It uses the current permissions, is computed on demand, and stores nothing:
1. **In-flight runs:** runs created in the chosen window that are still `queued`, `in_progress`, `waiting` or `pending`. Shows their age in that state and the runner labels requested. **No** "stuck" or outage label.
2. **Unsuccessful runs:** runs in the window that concluded `failure`, `cancelled`, `timed_out` or `startup_failure`. Shows GitHub's conclusion as reported, with the cause `unknown`, and links to GitHub to re-run.
3. **Scheduled workflows:** for workflows with `on.schedule`, "possible missed scheduled runs", comparing the cron at the default branch with `schedule` runs. Also shows the workflow `state`, including `disabled_inactivity`. Every gap is labelled "possible, cause unknown", with the cron source and tolerance stated.

Left out of this smallest version: infrastructure cause, events that never appeared, PRs' required-check status, and runner health.

**This is evidence for a later decision, not a decision.** K-10 stays unapproved, and the maintainer interviews (§5) are still outstanding.

### 9.7 Fixtures needed before any build

All synthetic, and needing approval under the ROADMAP rules:
- a stuck-queued run;
- a re-run with a large `created_at` gap;
- a run `pending` behind concurrency;
- `startup_failure` with no jobs;
- `timed_out`;
- a schedule series with a gap, a cron change, `disabled_inactivity` and several cron lines;
- self-hosted and larger-runner queued jobs;
- a fork-PR run with empty `pull_requests`;
- a window of more than 1,000 runs.

A real infrastructure-error message should be added only if captured from a cited public source.

### 9.8 Live probe results (2026-10-30 UTC)

**Method:**
- GET requests to `api.github.com` (REST version 2022-11-28) on 2026-10-30 between about 00:45 and 00:55 UTC. A throwaway script outside the repository printed only status codes, field names, counts and run or job IDs. 33 requests; no response content is stored.
- **All requests were unauthenticated.**
  - The app's token is a fine-grained PAT held only in the browser's memory, so it isn't available to this environment.
  - The only token present is the GitHub CLI's OAuth token. Its classic scopes (`repo`, `workflow`) are broader than the app's, so a result obtained with it would **not** represent the app's configuration. It was deliberately not used.
- **Why unauthenticated results transfer to the app's token:** GitHub documents that fine-grained tokens "always include read-only access to all public repositories" ([managing personal access tokens](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)). So an endpoint readable anonymously on a public repository is expected to be readable by the app's token there.
  - That is an inference from the documentation, **not** a test with the app's token.
  - Private repositories were not tested and remain governed by the permissions table in signal 5.
- **How failures are distinguished:**
  - *permission failure:* 401 or 403;
  - *missing data:* 200 with an empty value;
  - *unsupported:* no such field or endpoint.
- No `X-Accepted-GitHub-Permissions` header was returned, as expected for unauthenticated requests.
- Results are a snapshot; the repositories' data changes continuously.

**P-1. Pull requests, check runs and commit statuses on a public repository.** Repository: `cli/cli`, default branch `trunk`.

| Endpoint | HTTP | Observed |
|---|---|---|
| `GET /repos/cli/cli/pulls?state=open&per_page=1` | **200** | PR list with `head.sha` and `draft`. The list has no `mergeable_state` field |
| `GET /repos/cli/cli/pulls/{n}` (that PR) | **200** | `mergeable_state` present (value `clean`) |
| `GET /repos/cli/cli/commits/{head sha}/check-runs` | **200** | `total_count` 6. Each run has `name`, `status`, `conclusion`, `started_at`, `completed_at`, `app`, `check_suite`, `output`, `pull_requests` |
| `GET /repos/cli/cli/check-runs/{id}/annotations` | **200** | An array (1 annotation) |
| `GET /repos/cli/cli/commits/{head sha}/status` | **200** | `state` `pending`, 0 statuses. With no statuses, `pending` is GitHub's empty value, not a waiting check |
| `GET /repos/cli/cli/rules/branches/trunk` | **200** | One rule, type `copilot_code_review`; no required-status-check rule |
| `GET /repos/cli/cli/branches/trunk/protection/required_status_checks` | **401** "Requires authentication" | **Permission failure.** The documented permission is Administration: Read, outside the app's set |
| `GET /repos/cli/cli/branches/trunk` | **200** | `protected: true`, and `protection.required_status_checks` with `enforcement_level` `non_admins`, 3 `contexts` and 3 `checks` (`context`, `app_id`) |

- **Result:** on a public repository, open PRs, a head's check runs, annotations and commit statuses are all readable without any token permission. The required check names for classic branch protection are exposed through the **branch** endpoint (`GET …/branches/{b}`, documented under Contents: Read), even though the protection endpoint itself is refused.
- **Not shown:**
  - whether the branch object's `required_status_checks` is complete in every case, for example with several protection layers or org rulesets;
  - whether `mergeable_state`, which GitHub computes, is reliable enough to say "blocked".

**P-2. `pull_requests` on runs from fork PRs.**

| Repository | Endpoint | Observed |
|---|---|---|
| `pytest-dev/pytest` | `GET …/actions/runs?event=pull_request&per_page=30` | 30 runs: **25 from forks, all with an empty `pull_requests`**. 5 from the same repository, all with a non-empty `pull_requests` |
| `cli/cli` | same | 30 runs, all from the same repository, all non-empty (no fork PRs in that sample) |
| `home-assistant/core` | `GET …/actions/runs/{id}` (two runs, P-3) | Fork PR runs, `pull_requests` empty |

- **Result:** confirmed in this sample. A fork PR's run carries **no PR number**. It's missing data, not a permission failure (status 200).
- Linking such a run to its PR needs another lookup, for example open PRs matched by head SHA or head label (`GET …/pulls`, readable per P-1).

**P-3. A job that is still queued.**

| Repository | Endpoint | Observed |
|---|---|---|
| `pytorch/pytorch` | `GET …/actions/runs?status=queued` | `total_count` 431 |
| same, run `40981113896` (push) | `GET …/actions/runs/{id}` | `status` `queued`, `conclusion` null. `run_started_at` **equals** `created_at` (00:40:03Z) while still queued. `updated_at` later (00:42:46Z) |
| same | `GET …/actions/runs/{id}/jobs?filter=latest` | 93 jobs, 18 `queued`. Two sampled queued jobs: `conclusion` null, **`started_at` equal to `created_at`**, `completed_at` null, `runner_id` 0, `runner_name` `""`, `runner_group_id` 0, `runner_group_name` `""`, 0 steps. `labels` were custom runner labels with **no `self-hosted` label** |
| `home-assistant/core`, runs `39791818345` and `39791818283` (fork PRs) | runs and jobs endpoints | `status` `queued` since **2026-10-22T13:59:33Z**. `updated_at` and `run_started_at` equal `created_at`. **0 jobs** |

- **Results:**
  - **Timestamps don't show queue time.** A queued job's `started_at` is not null; it equals `created_at`. So `started_at − created_at` is 0 while a job waits. Time in queue must be "now − `created_at`" while `status` is `queued`.
  - **`run_started_at` isn't a start signal on attempt 1.** It too equals `created_at` while the run is queued.
  - **"No runner assigned"** is shown as `runner_id` 0 and empty strings, not null. (The fixtures' skipped jobs use null.)
  - **Labels can't separate self-hosted runners.** pytorch's queued jobs requested custom labels without `self-hosted`, so this is confirmed as a limitation, not just an assumption.
  - **Queued runs with no jobs exist.** The two home-assistant runs had been queued for over 7 days with no jobs and no update. That is a real example of the state GitHub described after I-9.
    - The cause is **unknown**. It could be a stale status, or something held before jobs were created; nothing in the response says which.
    - The 24-hour queue limit (documented for jobs) evidently didn't end them.
- **Not shown:**
  - whether `started_at` is overwritten with the real start time once a job is picked up (the fixtures' 0–7 s gaps suggest so, but this probe didn't observe a transition);
  - whether `pending` and `waiting` behave the same.

**P-4. Events API permission.**

| Repository | Endpoint | Observed |
|---|---|---|
| `cli/cli` | `GET /repos/cli/cli/events?per_page=30` | **200**; 30 events (issue comment, watch, fork, review, delete). No `PushEvent` in that page |

- **Documentation:** the [events docs](https://docs.github.com/en/rest/activity/events) give no fine-grained permission for repository events, and the [permissions page](https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens) doesn't list the endpoint. Only user-private events need a permission ("Events", user).
- **Result:** readable without any permission on a public repository, so readable with the app's token there by the inference above. The exact fine-grained permission for **private** repositories is **unresolved**.
- **Usefulness:** a 30-event page on a busy repository contained no push at all, consistent with the documented 300-event, 30-day and up to 6-hour latency limits. That supports keeping signal 4 out of scope.

**Revised open questions:**
- **Resolved:**
  - fork PR runs have an empty `pull_requests` (P-2);
  - a queued job shows `started_at` = `created_at` and an empty runner (P-3);
  - on public repositories, PRs, check runs, annotations, commit statuses, rulesets, repository events, and required check names through the branch object are readable without permissions (P-1, P-4).
- **Still unresolved:**
  1. Behaviour with the app's **actual** fine-grained PAT. It's expected to match the unauthenticated results on public repositories, but this wasn't tested. A maintainer could check by running the same GETs with their token, without sharing it.
  2. **Private repositories:** endpoints outside Actions, Contents and Metadata are expected to fail. Not tested, and not to be tested by expanding permissions (Q2).
  3. Whether the branch object's `required_status_checks` reflects every source of required checks (classic protection plus rulesets, including organization rulesets), and whether it is visible on every public repository.
  4. Whether a job's `started_at` changes to its real start when a runner picks it up.
  5. The cause of week-old queued runs with no jobs. It isn't knowable from the API, so it stays `unknown`.
  6. The events API's fine-grained permission for private repositories.

### 9.9 What current access demonstrably supports (public repositories)

Checked against the catch-up list in §9.6. **None of this approves implementation;** K-10 stays unapproved, and the maintainer interviews (§5) are still required.

| Part of the catch-up list | Demonstrated? | Notes |
|---|---|---|
| 1. Runs still in flight, with time in state | **Yes**, with a correction | `status=queued` filter works (P-3). Time in state is "now − `created_at`", because `started_at` and `run_started_at` equal `created_at` while queued. Week-old queued runs with no jobs exist and must be shown with the cause `unknown` |
| 1a. Runner labels requested; "no runner assigned" | **Yes** | `labels`; `runner_id` 0 and `runner_name` `""`. Labels can't tell self-hosted from hosted |
| 2. Unsuccessful runs in a window | **Documented, not probed** | The `created` filter and conclusion filters are documented, but this probe didn't exercise them |
| 3. Possible missed scheduled runs | **Not probed live** | Relies on documented `event=schedule`, workflow `state` and file contents; no live schedule series examined |
| Fork PR runs linked to their PR | **Needs an extra lookup** | `pull_requests` is empty (P-2), so matching by head is needed (P-1 endpoints are readable) |
| PRs waiting on required checks | **Possible on public repositories, beyond the original plan** | Open PRs, check runs, statuses and required check names (through the branch object) were readable unauthenticated. The original "not feasible" holds for **private** repositories, and the public result is untested with the app's own token |

So the smallest catch-up list (§9.6) stands, with these changes:
- queue time must be measured from `created_at`;
- "queued with no jobs" belongs on the list as its own case, cause `unknown`;
- for public repositories only, a later, separate decision could consider showing PRs whose head commit has unfinished or failed required checks. That would use reads that the probes show need no extra permission there. It isn't part of the smallest version, and it doesn't change Q2.
