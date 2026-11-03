// Snapshot preparation: resolves a workflow's complete execution dependency graph (reusable workflows, local and
// external actions, nested composite actions, scripts) at exact commits, checks it against what the emergency runner
// can reproduce, and packages every file it needs. Runs while GitHub is available, through a SourceReader (the
// browser's read-only GitHub client, or the fixture API). Pure apart from the reader.
import { analyse, ExpressionError, FUNCTIONS, parseCondition, parseExpression, templateExpressions } from "./expressions.ts";
import { checkRunScript } from "./script-substitution.ts";
import type { ActionDef, Diagnostic, InputSpec, JobDef, StepDef, WorkflowDef } from "./model.ts";
import { DefinitionError, isCheckout, isWorkflowPath, normalizePath, parseAction, parseUses, parseWorkflow } from "./model.ts";
import type { ActionEntry, FileEntry, GraphJob, GraphStep, Manifest, Requirement, RootEntry, RootId, WorkflowEntry } from "./snapshot.ts";
import { LIMITS, repoRoot, SNAPSHOT_SCHEMA, sha256Hex, WORKSPACE } from "./snapshot.ts";

/** `gitBlob`: the Git blob ID the source reports for the file (security review H1). */
export type TreeFile = { path: string; size: number; executable?: boolean; gitBlob?: string };

/** Read-only access to repositories at exact commits. */
export interface SourceReader {
  resolveCommit(repository: string, ref: string): Promise<string>;
  listFiles(repository: string, sha: string): Promise<TreeFile[]>;
  readFile(repository: string, sha: string, path: string): Promise<Uint8Array>;
  /** The Git tree ID of the commit, and how many entries listFiles left out (symlinks, submodules). */
  treeInfo?(repository: string, sha: string): Promise<{ treeSha: string; skipped: number }>;
}

export type PrepareOptions = {
  repository: string;
  ref: string;
  /** Pin to this commit; otherwise `ref` is resolved once and every file is read at the result. */
  sha?: string;
  workflows: string[];
  name: string;
  expiresInDays: number;
  /** Workspace path prefixes to package (supporting files). Empty or absent: the whole repository. */
  include?: string[];
  onProgress?: (message: string) => void;
};

export class PrepareError extends Error {}

/** `github` context keys the runner provides (as values for an emergency run, not GitHub's). */
const GITHUB_KEYS = new Set([
  "repository", "repository_owner", "sha", "ref", "ref_name", "ref_type", "workflow", "run_id", "run_number", "run_attempt", "actor",
  "triggering_actor", "event_name", "workspace", "action", "action_path", "job", "server_url", "api_url", "head_ref", "base_ref", "event",
]);
const CONTEXTS = new Set(["github", "env", "inputs", "secrets", "vars", "steps", "needs", "job", "runner", "jobs", "matrix", "strategy"]);
const NODE_BUILTINS = new Set(
  ("assert buffer child_process cluster console constants crypto dgram diagnostics_channel dns domain events fs http http2 https inspector " +
    "module net os path perf_hooks process punycode querystring readline repl stream string_decoder sys timers tls trace_events tty url " +
    "util v8 vm wasi worker_threads zlib test sqlite async_hooks").split(" "),
);
const NETWORK_HINTS: [RegExp, string][] = [
  [/\bnpm\s+(?:ci|install|i)\b|\byarn(?:\s+install)?\b|\bpnpm\s+(?:i|install)\b/, "npm registry (package install)"],
  [/\bpip3?\s+install\b|\bpython3?\s+-m\s+pip\s+install\b|\bpoetry\s+install\b/, "Python package index (pip install)"],
  [/\bapt(?:-get)?\s+install\b|\bapk\s+add\b/, "OS package repository"],
  [/\bcurl\b|\bwget\b/, "HTTP download (curl/wget)"],
  [/\bgit\s+(?:clone|fetch|pull|push|ls-remote)\b/, "Git remote (likely GitHub)"],
  [/\bgh\s+[a-z]/, "GitHub CLI (GitHub API)"],
  [/github\.com|githubusercontent\.com|ghcr\.io/, "GitHub host named in the script"],
  [/\bdocker\s+(?:pull|push|login|run|build)\b/, "Container registry (docker)"],
];
/** Actions whose purpose is a GitHub service that is unavailable during an outage. */
const GITHUB_SERVICE_ACTIONS: Record<string, string> = {
  "actions/upload-artifact": "stores artifacts in GitHub",
  "actions/download-artifact": "downloads artifacts from GitHub",
  "actions/cache": "uses GitHub's cache service",
  "actions/github-script": "calls the GitHub API with GitHub's token",
  "actions/setup-node": "downloads Node.js from GitHub or nodejs.org",
  "actions/setup-python": "downloads Python from GitHub",
  "actions/setup-go": "downloads Go",
  "actions/setup-java": "downloads a JDK",
  "actions/create-release": "calls the GitHub API",
  "actions/deploy-pages": "deploys to GitHub Pages",
  "actions/upload-pages-artifact": "stores a Pages artifact in GitHub",
};

type Root = {
  id: RootId;
  repository: string;
  ref: string;
  sha: string;
  kind: RootEntry["kind"];
  tree: Map<string, number>;
  executable: Set<string>;
  whole: boolean;
  blobs: Map<string, string>;
  gitTree?: string;
  /** Entries the source couldn't list as regular files; any makes the tree unrecomputable. */
  skipped: number;
  /** Files left out of the package (not selected, or too large). */
  omitted: number;
};

export async function prepareSnapshot(reader: SourceReader, opts: PrepareOptions, now = new Date()): Promise<{ manifest: Manifest; contents: Map<string, Uint8Array> }> {
  const progress = opts.onProgress ?? (() => {});
  const diagnostics: Diagnostic[] = [];
  const diag = (severity: Diagnostic["severity"], code: string, message: string, where?: string) => {
    if (!diagnostics.some((d) => d.code === code && d.message === message && d.where === where)) diagnostics.push({ severity, code, message, where });
  };
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(opts.repository)) throw new PrepareError("Repository must be OWNER/REPO");
  if (!opts.workflows.length) throw new PrepareError("Select at least one workflow");
  if (!(opts.expiresInDays >= 1 && opts.expiresInDays <= LIMITS.maxExpiryDays)) throw new PrepareError(`Expiry must be 1–${LIMITS.maxExpiryDays} days`);

  progress(`Resolving ${opts.ref}…`);
  const sha = opts.sha ?? (await reader.resolveCommit(opts.repository, opts.ref));
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new PrepareError(`Could not resolve ${opts.ref} to a commit`);

  const roots = new Map<RootId, Root>();
  const fileCache = new Map<string, Uint8Array>();
  const loadRoot = async (repository: string, ref: string, rootSha: string, kind: Root["kind"], id: RootId): Promise<Root> => {
    const existing = roots.get(id);
    if (existing) {
      if (kind === "action") existing.whole = true;
      return existing;
    }
    progress(`Listing ${repository}@${rootSha.slice(0, 7)}…`);
    const files = await reader.listFiles(repository, rootSha);
    const info = reader.treeInfo ? await reader.treeInfo(repository, rootSha) : undefined;
    const root: Root = {
      id,
      repository,
      ref,
      sha: rootSha,
      kind,
      tree: new Map(files.map((f) => [f.path, f.size])),
      executable: new Set(files.filter((f) => f.executable).map((f) => f.path)),
      whole: kind !== "workflow",
      blobs: new Map(files.flatMap((f) => (f.gitBlob ? [[f.path, f.gitBlob] as [string, string]] : []))),
      gitTree: info?.treeSha,
      skipped: info?.skipped ?? 0,
      omitted: 0,
    };
    roots.set(id, root);
    return root;
  };
  const read = async (root: Root, path: string): Promise<Uint8Array> => {
    const key = `${root.id}:${path}`;
    let data = fileCache.get(key);
    if (!data) {
      data = await reader.readFile(root.repository, root.sha, path);
      fileCache.set(key, data);
    }
    return data;
  };
  const readText = async (root: Root, path: string) => new TextDecoder().decode(await read(root, path));
  const workflowFiles = new Set<string>(); // `${root}:${path}` read for remote reusable workflows

  const workspace = await loadRoot(opts.repository, opts.ref, sha, "workspace", WORKSPACE);
  const remoteCommits = new Map<string, string>();
  const resolveRemote = async (owner: string, repo: string, ref: string, where: string): Promise<string | null> => {
    const key = `${owner}/${repo}@${ref}`;
    if (remoteCommits.has(key)) return remoteCommits.get(key)!;
    try {
      const resolved = /^[0-9a-f]{40}$/.test(ref) ? ref : await reader.resolveCommit(`${owner}/${repo}`, ref);
      remoteCommits.set(key, resolved);
      if (!/^[0-9a-f]{40}$/.test(ref)) diag("info", "pinned", `${key} resolved to ${resolved}; the snapshot keeps that commit`, where);
      return resolved;
    } catch (error) {
      diag("error", "resolve-failed", `Could not resolve ${key}: ${(error as Error).message}`, where);
      return null;
    }
  };

  const workflows: WorkflowEntry[] = [];
  const actions = new Map<string, ActionEntry>();
  const secrets = new Map<string, Set<string>>();
  const variables = new Map<string, Set<string>>();
  const services = new Map<string, Set<string>>();
  const runtimes = new Set<string>();
  const inputs: Record<string, Record<string, InputSpec>> = {};
  const need = (map: Map<string, Set<string>>, name: string, where: string) => {
    if (!map.has(name)) map.set(name, new Set());
    map.get(name)!.add(where);
  };

  /** Scope for expression checks: which secrets are reachable, and whether they reach the caller (top level). */
  type Scope = { secretsTopLevel: boolean; declaredSecrets?: Set<string>; inherit: boolean; allowJobs?: boolean; composite?: boolean };

  const checkText = (text: unknown, where: string, scope: Scope, isCondition = false) => {
    if (text === undefined || text === null) return;
    const sources: string[] = [];
    if (isCondition) {
      try {
        const e = parseCondition(text);
        checkExpr(analyse(e), where, scope);
      } catch (error) {
        diag("error", "expression", `${(error as Error).message} in if: ${String(text)}`, where);
      }
      return;
    }
    sources.push(...templateExpressions(String(text)));
    for (const src of sources) {
      try {
        checkExpr(analyse(parseExpression(src)), where, scope);
      } catch (error) {
        diag("error", "expression", `${error instanceof ExpressionError ? error.message : String(error)} in \${{ ${src} }}`, where);
      }
    }
  };

  const checkExpr = (use: ReturnType<typeof analyse>, where: string, scope: Scope) => {
    for (const f of use.functions) if (!FUNCTIONS.has(f)) diag("error", "function", `${f}() is not supported by the emergency runner`, where);
    for (const ctx of use.dynamicContexts) diag("error", "dynamic-context", `A computed ${ctx}[…] lookup can't be checked or supplied in advance`, where);
    for (const ref of use.references) {
      const [root, second, third] = ref.split(".");
      if (!root || !CONTEXTS.has(root)) {
        diag("error", "context", `Unknown or unsupported context "${ref}"`, where);
        continue;
      }
      if (root === "matrix" || root === "strategy") diag("error", "matrix", "Matrix strategies are not supported", where);
      if (root === "jobs" && !scope.allowJobs) diag("error", "context", `"${ref}" is only available in workflow_call outputs`, where);
      if (root === "secrets") {
        if (scope.composite) diag("error", "secrets", "Composite actions can't read the secrets context; pass the value as an input", where);
        else if (!second) diag("error", "secrets", "The whole secrets context can't be passed", where);
        else if (second.toUpperCase() === "GITHUB_TOKEN") diag("error", "github-token", "secrets.GITHUB_TOKEN is issued by GitHub for each run and is not available during an outage", where);
        else if (scope.secretsTopLevel || scope.inherit) need(secrets, second, where);
        else if (scope.declaredSecrets && !scope.declaredSecrets.has(second.toLowerCase())) diag("warning", "secret-undeclared", `secrets.${second} is not declared in workflow_call and will be empty`, where);
      }
      if (root === "vars") {
        if (!second) diag("error", "vars", "The whole vars context can't be used", where);
        else need(variables, second, where);
      }
      if (root === "github") {
        if (!second) diag("warning", "github-context", "The github context is an emergency-run substitute, not GitHub's", where);
        else if (second === "token") diag("error", "github-token", "github.token is issued by GitHub for each run and is not available during an outage", where);
        else if (second === "event" && third !== "inputs") diag("error", "event-payload", `"${ref}" needs a GitHub event payload; emergency runs have only inputs`, where);
        else if (!GITHUB_KEYS.has(second)) diag("warning", "github-context", `"${ref}" is not provided by the emergency runner and evaluates to empty`, where);
      }
    }
  };

  const scanRun = (run: string, workingDirectory: string | undefined, where: string, tree: Map<string, number>): string[] => {
    for (const [pattern, what] of NETWORK_HINTS) if (pattern.test(run)) need(services, what, where);
    const scripts: string[] = [];
    const base = workingDirectory ? normalizePath(workingDirectory.replace(/^\.\//, "")) : "";
    for (const m of run.matchAll(/(?:^|[\s"'=(])(\.?\/?[\w./-]+\.(?:py|sh|bash|js|mjs|cjs))(?=$|[\s"');|&])/gm)) {
      const raw = m[1]!.replace(/^\.\//, "");
      if (raw.includes("${{")) continue;
      const candidates = [base ? `${base}/${raw}` : raw, raw].map((p) => normalizePath(p)).filter((p): p is string => !!p);
      const found = candidates.find((p) => tree.has(p));
      if (found) scripts.push(found);
      else if (/^(?:python3?|bash|sh|node)\s/.test(run.slice(Math.max(0, (m.index ?? 0) - 10)).trimStart()) || raw.includes("/")) {
        diag("warning", "script-missing", `Script "${raw}" referenced in run: was not found in the packaged files (it may be created at run time)`, where);
      }
      if (/\.py$/.test(raw)) runtimes.add("python");
      if (/\.(?:sh|bash)$/.test(raw)) runtimes.add("bash");
      if (/\.(?:js|mjs|cjs)$/.test(raw)) runtimes.add("node");
    }
    if (/\bpython3?\b/.test(run)) runtimes.add("python");
    if (/\bnode\b/.test(run)) runtimes.add("node");
    return [...new Set(scripts)];
  };

  const checkShell = (shell: string | undefined, where: string) => {
    const s = (shell ?? "bash").trim();
    if (/^(?:bash|sh|python)$/.test(s) || /^(?:bash|sh|python3?)\b.*\{0\}/.test(s)) {
      runtimes.add(s.startsWith("python") ? "python" : s.startsWith("sh") ? "sh" : "bash");
      return s;
    }
    diag("error", "shell", `shell: ${s} is not available in the emergency runner (bash, sh and python are)`, where);
    return s;
  };

  /** Checks a JavaScript action's entry point and the packages it imports. */
  const checkNodeAction = async (root: Root, dir: string, action: ActionDef, where: string) => {
    runtimes.add("node");
    if (/^node(?:12|16)$/.test(action.runtime)) diag("error", "node-runtime", `${action.runtime} actions are deprecated by GitHub and not supported`, where);
    else if (action.runtime !== "node22") diag("warning", "node-runtime", `${action.runtime} action runs on the runner image's Node.js 22`, where);
    if (action.pre) diag("error", "action-pre", "Actions with a pre: script are not supported", where);
    if (!action.main) {
      diag("error", "action-main", "JavaScript action has no runs.main", where);
      return;
    }
    const main = normalizePath(dir ? `${dir}/${action.main.replace(/^\.\//, "")}` : action.main.replace(/^\.\//, ""));
    if (!main || !root.tree.has(main)) {
      diag("error", "action-main", `Entry point ${action.main} is not in ${root.repository}@${root.sha.slice(0, 7)}`, where);
      return;
    }
    for (const entry of [main, ...(action.post ? [normalizePath(dir ? `${dir}/${action.post}` : action.post)] : [])]) {
      if (!entry || !root.tree.has(entry)) continue;
      const code = await readText(root, entry);
      const specifiers = new Set<string>();
      for (const m of code.matchAll(/\brequire\(\s*["']([^"']+)["']\s*\)|\bfrom\s*["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)|^\s*import\s+["']([^"']+)["']/gm)) {
        specifiers.add((m[1] ?? m[2] ?? m[3] ?? m[4])!);
      }
      for (const spec of specifiers) {
        if (spec.startsWith(".") || spec.startsWith("/")) continue;
        const bare = spec.replace(/^node:/, "");
        if (NODE_BUILTINS.has(bare.split("/")[0]!)) continue;
        const pkg = bare.startsWith("@") ? bare.split("/").slice(0, 2).join("/") : bare.split("/")[0]!;
        const dirs = entry.split("/").slice(0, -1);
        let found = false;
        for (let i = dirs.length; i >= 0 && !found; i--) {
          const prefix = [...dirs.slice(0, i), "node_modules", pkg].join("/");
          found = [...root.tree.keys()].some((p) => p.startsWith(`${prefix}/`));
        }
        if (!found) diag("error", "action-dependency", `${entry} imports "${spec}", but node_modules/${pkg} is not packaged with the action (bundle it, or commit node_modules)`, where);
      }
    }
  };

  const findActionFile = (root: Root, dir: string) => ["action.yml", "action.yaml"].map((f) => (dir ? `${dir}/${f}` : f)).find((p) => root.tree.has(p));

  /** Resolves one `uses:` step (recursively for composite actions). Returns the graph step. */
  const resolveStepAction = async (step: StepDef, where: string, depth: number): Promise<GraphStep> => {
    const label = step.name ?? step.id ?? step.uses!;
    const u = parseUses(step.uses!);
    const graph: GraphStep = { index: step.index, label, kind: "action", scripts: [] };
    if (u.kind === "invalid") {
      diag("error", "uses", `Invalid uses: ${step.uses}`, where);
      return graph;
    }
    if (u.kind === "docker") {
      diag("error", "docker-action", `Docker actions (${step.uses}) are not supported`, where);
      return graph;
    }
    if (isCheckout(u)) {
      graph.kind = "checkout";
      const repoInput = step.with.repository;
      if (repoInput && repoInput.toLowerCase() !== opts.repository.toLowerCase() && !repoInput.includes("${{")) diag("error", "checkout", `Checking out another repository (${repoInput}) needs GitHub`, where);
      if (step.with.ref && !step.with.ref.includes("${{")) diag("warning", "checkout", `checkout ref "${step.with.ref}" is ignored: the packaged workspace is the snapshot commit`, where);
      if (step.with.path) diag("error", "checkout", "checkout with path: is not supported", where);
      for (const k of Object.keys(step.with)) if (!["repository", "ref", "path", "fetch-depth", "token", "persist-credentials", "clean", "lfs", "submodules"].includes(k)) diag("warning", "checkout", `checkout input ${k} is ignored`, where);
      if (step.with.submodules && step.with.submodules !== "false") diag("error", "checkout", "Submodules are not packaged", where);
      if (step.with.lfs === "true") diag("error", "checkout", "Git LFS content is not packaged", where);
      actions.set(step.uses!, { key: step.uses!, root: WORKSPACE, dir: "", file: "", using: "checkout", runtime: "", substitutedBy: "packaged-workspace" });
      diag("info", "checkout-substituted", `${step.uses} is replaced by restoring the packaged workspace at ${sha.slice(0, 7)}`, where);
      return graph;
    }
    if (depth > LIMITS.maxDepth) {
      diag("error", "depth", "Composite actions are nested too deeply", where);
      return graph;
    }
    let root: Root;
    let dir: string;
    if (u.kind === "local") {
      root = workspace;
      dir = u.path;
    } else {
      const service = GITHUB_SERVICE_ACTIONS[`${u.owner}/${u.repo}`.toLowerCase()];
      if (service) diag("error", "github-service", `${step.uses} ${service}, which is unavailable during a GitHub outage`, where);
      const resolved = await resolveRemote(u.owner, u.repo, u.ref, where);
      if (!resolved) return graph;
      root = await loadRoot(`${u.owner}/${u.repo}`, u.ref, resolved, "action", repoRoot(u.owner, u.repo, resolved));
      dir = u.path;
    }
    graph.action = step.uses!;
    const file = findActionFile(root, dir);
    if (!file) {
      diag("error", "action-missing", `No action.yml in ${root.repository}${dir ? `/${dir}` : ""}@${root.sha.slice(0, 7)}`, where);
      return graph;
    }
    if (actions.has(step.uses!)) return graph;
    let action: ActionDef;
    try {
      action = parseAction(`${root.repository}/${file}`, await readText(root, file));
    } catch (error) {
      diag("error", "action-invalid", (error as Error).message, where);
      return graph;
    }
    actions.set(step.uses!, { key: step.uses!, root: root.id, dir, file, using: action.using, runtime: action.runtime });
    const actionWhere = `${step.uses}`;
    for (const [name, spec] of Object.entries(action.inputs)) {
      if (spec.required && !(name in step.with) && spec.default === undefined) diag("warning", "action-input", `Required input "${name}" is not set`, where);
      if (spec.default && /github\.token/.test(spec.default) && !(name in step.with)) diag("warning", "github-token", `Input "${name}" defaults to github.token, which will be empty`, actionWhere);
    }
    if (action.using === "node") await checkNodeAction(root, dir, action, actionWhere);
    else if (action.using === "composite") {
      const inner: Scope = { secretsTopLevel: false, inherit: false, composite: true };
      for (const s of action.steps) {
        const w = `${actionWhere} step ${s.index + 1}`;
        await resolveStep(s, w, depth + 1, inner, root.tree, true);
      }
      for (const v of Object.values(action.outputs)) checkText(v, actionWhere, inner);
    } else diag("error", "action-type", `${action.runtime || "unknown"} actions are not supported (${step.uses})`, where);
    return graph;
  };

  const resolveStep = async (step: StepDef, where: string, depth: number, scope: Scope, tree: Map<string, number>, composite = false): Promise<GraphStep> => {
    checkText(step.if, where, scope, true);
    for (const v of [...Object.values(step.with), ...Object.values(step.env), step.workingDirectory]) checkText(v, where, scope);
    if (step.continueOnError !== false && typeof step.continueOnError !== "boolean") checkText(step.continueOnError, where, scope);
    if (step.run !== undefined) {
      checkText(step.run, where, scope);
      if (composite && !step.shell) diag("error", "shell", "Composite run steps must set shell:", where);
      const shell = checkShell(step.shell, where);
      // Security review M1: a ${{ }} value is passed to the script as an environment variable, not pasted into it.
      const language = shell.startsWith("python") ? "python" : "shell";
      const subst = checkRunScript(step.run, language);
      if (subst.reject) diag("error", "run-expression", `This run: step cannot run safely: ${subst.reject}`, where);
      else if (subst.count) diag("info", "run-expression", `${subst.count} \${{ }} expression${subst.count > 1 ? "s" : ""} in run: are passed as environment variables and used as data, not inserted into the script text (security review M1)`, where);
      if (/^::(set-output|save-state)\b/m.test(step.run)) diag("warning", "deprecated-command", "::set-output:: / ::save-state:: on stdout is deprecated by GitHub and ignored by the runner; write to the $GITHUB_OUTPUT or $GITHUB_STATE file", where);
      return { index: step.index, label: step.name ?? step.id ?? step.run.split("\n")[0]!.slice(0, 60), kind: "run", shell, scripts: scanRun(step.run, step.workingDirectory, where, tree) };
    }
    if (step.uses) return resolveStepAction(step, where, depth);
    diag("error", "step", "Step has neither run: nor uses:", where);
    return { index: step.index, label: step.name ?? `step ${step.index + 1}`, kind: "run", scripts: [] };
  };

  const workflowKeys = new Set<string>();
  /** Resolves a workflow (entry or called). `scope` decides whether its secrets are requirements of the caller. */
  const resolveWorkflow = async (root: Root, path: string, key: string, depth: number, scope: Scope, chain: string[]): Promise<WorkflowDef | null> => {
    if (chain.includes(key)) {
      diag("error", "cycle", `Reusable workflow cycle: ${[...chain, key].join(" → ")}`, key);
      return null;
    }
    if (depth > LIMITS.maxDepth) {
      diag("error", "depth", "Reusable workflows are nested too deeply", key);
      return null;
    }
    if (!root.tree.has(path)) {
      diag("error", "workflow-missing", `${path} is not in ${root.repository}@${root.sha.slice(0, 7)}`, key);
      return null;
    }
    progress(`Resolving ${key}…`);
    let wf: WorkflowDef;
    try {
      wf = parseWorkflow(path, await readText(root, path));
    } catch (error) {
      diag("error", "workflow-invalid", error instanceof DefinitionError ? error.message : String(error), key);
      return null;
    }
    if (root.id !== WORKSPACE) workflowFiles.add(`${root.id}:${path}`);
    // A called workflow sees only the secrets it declares (unless they are inherited).
    if (!scope.secretsTopLevel && !scope.inherit && wf.call) scope = { ...scope, declaredSecrets: new Set(Object.keys(wf.call.secrets).map((s) => s.toLowerCase())) };
    const entry: WorkflowEntry = { key, root: root.id, path, name: wf.name, jobs: [] };
    if (!workflowKeys.has(key)) {
      workflowKeys.add(key);
      workflows.push(entry);
    }
    for (const v of Object.values(wf.env)) checkText(v, key, scope);
    const jobIds = new Set(wf.jobs.map((j) => j.id));
    for (const job of wf.jobs) {
      const where = `${key} job ${job.id}`;
      for (const n of job.needs) if (!jobIds.has(n)) diag("error", "needs", `needs: ${n} is not a job in this workflow`, where);
      for (const k of job.unsupportedKeys) diag("error", "job-feature", `${k}: is not supported by the emergency runner`, where);
      for (const k of job.ignoredKeys) diag("warning", "job-ignored", `${k}: is not enforced in emergency runs${k === "environment" ? " (no protection rules, environment secrets or deployment records)" : k === "runs-on" ? " (every job runs in the emergency runner image)" : ""}`, where);
      checkText(job.if, where, scope, true);
      for (const v of Object.values(job.env)) checkText(v, where, scope);
      const graphJob: GraphJob = { id: job.id, name: job.name, needs: job.needs, kind: job.uses ? "call" : "steps", steps: [] };
      if (job.uses) await resolveCall(job, where, depth, scope, chain.concat(key), graphJob);
      else {
        for (const v of Object.values(job.outputs)) checkText(v, where, scope);
        if (!job.steps.length) diag("error", "job-empty", "Job has no steps", where);
        for (const step of job.steps) graphJob.steps.push(await resolveStep(step, `${where} step ${step.index + 1}`, depth, scope, workspace.tree));
      }
      entry.jobs.push(graphJob);
    }
    if (wf.call) for (const v of Object.values(wf.call.outputs)) checkText(v, key, { ...scope, allowJobs: true });
    detectNeedsCycle(wf.jobs, key);
    return wf;
  };

  const detectNeedsCycle = (jobs: JobDef[], key: string) => {
    const state = new Map<string, number>();
    const byId = new Map(jobs.map((j) => [j.id, j]));
    const visit = (id: string): boolean => {
      if (state.get(id) === 1) return true;
      if (state.get(id) === 2) return false;
      state.set(id, 1);
      const cyclic = (byId.get(id)?.needs ?? []).some((n) => byId.has(n) && visit(n));
      state.set(id, 2);
      return cyclic;
    };
    if (jobs.some((j) => visit(j.id))) diag("error", "needs-cycle", "Jobs depend on each other in a cycle", key);
  };

  const resolveCall = async (job: JobDef, where: string, depth: number, scope: Scope, chain: string[], graphJob: GraphJob) => {
    const u = parseUses(job.uses!);
    for (const v of Object.values(job.with)) checkText(v, where, scope);
    if (job.secrets !== "inherit") for (const v of Object.values(job.secrets)) checkText(v, where, scope);
    let root: Root;
    let path: string;
    if (u.kind === "local" && isWorkflowPath(u.path)) {
      root = workspace;
      path = u.path;
    } else if (u.kind === "remote" && isWorkflowPath(u.path)) {
      const resolved = await resolveRemote(u.owner, u.repo, u.ref, where);
      if (!resolved) return;
      root = await loadRoot(`${u.owner}/${u.repo}`, u.ref, resolved, "workflow", repoRoot(u.owner, u.repo, resolved));
      path = u.path;
    } else {
      diag("error", "reusable", `uses: ${job.uses} is not a reusable workflow under .github/workflows`, where);
      return;
    }
    const key = root.id === WORKSPACE ? `./${path}` : job.uses!;
    graphJob.calls = key;
    const inherit = job.secrets === "inherit";
    const callee = await resolveWorkflow(root, path, key, depth + 1, { secretsTopLevel: false, inherit: inherit && (scope.secretsTopLevel || scope.inherit), declaredSecrets: undefined }, chain);
    if (!callee) return;
    if (!callee.call) {
      diag("error", "reusable", `${key} has no on: workflow_call`, where);
      return;
    }
    for (const k of Object.keys(job.with)) if (!(k in callee.call.inputs)) diag("error", "reusable-input", `Input "${k}" is not declared by ${key}`, where);
    for (const [k, spec] of Object.entries(callee.call.inputs)) if (spec.required && !(k in job.with) && spec.default === undefined) diag("error", "reusable-input", `Required input "${k}" of ${key} is not passed`, where);
    if (!inherit) {
      const passed = job.secrets as Record<string, string>;
      for (const k of Object.keys(passed)) if (!(k in callee.call.secrets)) diag("error", "reusable-secret", `Secret "${k}" is not declared by ${key}`, where);
      for (const [k, spec] of Object.entries(callee.call.secrets)) if (spec.required && !(k in passed)) diag("error", "reusable-secret", `Required secret "${k}" of ${key} is not passed`, where);
    }
  };

  // Entry workflows: their inputs and secrets are what the operator supplies at execution time.
  for (const path of opts.workflows) {
    const clean = normalizePath(path);
    if (!clean || !isWorkflowPath(clean)) throw new PrepareError(`${path} is not a workflow file under .github/workflows`);
    const wf = await resolveWorkflow(workspace, clean, clean, 0, { secretsTopLevel: true, inherit: false }, []);
    if (!wf) continue;
    inputs[clean] = { ...wf.dispatchInputs, ...(wf.call?.inputs ?? {}) };
    const triggers = wf.triggers.filter((t) => t !== "workflow_dispatch");
    if (triggers.length) diag("info", "triggers", `Triggers (${triggers.join(", ")}) are not reproduced: an emergency run starts manually, like workflow_dispatch, with only its inputs`, clean);
  }

  // Packaging: the workspace (or the selected prefixes), whole repositories of external actions, and the files of
  // external reusable workflows.
  const include = (opts.include ?? []).map((p) => normalizePath(p.replace(/^\.\//, ""))).filter((p): p is string => p !== null && p !== "");
  const wanted = (root: Root, path: string) => {
    if (root.id === WORKSPACE) {
      if (/^\.git\//.test(path)) return false;
      if (!include.length) return true;
      return path.startsWith(".github/") || include.some((p) => path === p || path.startsWith(`${p}/`));
    }
    return root.whole || workflowFiles.has(`${root.id}:${path}`);
  };
  const plan: { root: Root; path: string; size: number }[] = [];
  for (const root of roots.values()) {
    let count = 0;
    for (const [path, size] of root.tree) {
      if (!wanted(root, path)) {
        root.omitted++;
        continue;
      }
      if (size > LIMITS.maxFileBytes) {
        root.omitted++;
        diag("error", "file-too-large", `${root.repository}/${path} is larger than ${LIMITS.maxFileBytes} bytes`, root.id);
        continue;
      }
      plan.push({ root, path, size });
      count++;
    }
    if (root.id !== WORKSPACE && count > LIMITS.maxRepoFiles) diag("error", "limits", `${root.repository} has ${count} files (limit ${LIMITS.maxRepoFiles})`, root.id);
  }
  for (const root of roots.values()) if (root.id === WORKSPACE) for (const s of workflows.flatMap((w) => w.jobs.flatMap((j) => j.steps.flatMap((st) => st.scripts)))) if (!wanted(root, s)) diag("error", "excluded-script", `Script ${s} is used but excluded from the packaged files`, s);
  const totalBytes = plan.reduce((n, f) => n + f.size, 0);
  if (plan.length > LIMITS.maxFiles) throw new PrepareError(`Too many files to package: ${plan.length} (limit ${LIMITS.maxFiles}). Choose supporting-file prefixes.`);
  if (totalBytes > LIMITS.maxBytes) throw new PrepareError(`Too much data to package: ${totalBytes} bytes (limit ${LIMITS.maxBytes}). Choose supporting-file prefixes.`);

  const contents = new Map<string, Uint8Array>();
  const files: FileEntry[] = [];
  let done = 0;
  const queue = [...plan];
  const worker = async () => {
    for (let item = queue.shift(); item; item = queue.shift()) {
      const data = await read(item.root, item.path);
      const hash = await sha256Hex(data);
      contents.set(hash, data);
      const gitBlob = item.root.blobs.get(item.path);
      files.push({ root: item.root.id, path: item.path, size: data.length, sha256: hash, ...(item.root.executable.has(item.path) ? { executable: true } : {}), ...(gitBlob ? { gitBlob } : {}) });
      if (++done % 25 === 0) progress(`Packaged ${done} of ${plan.length} files…`);
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  files.sort((a, b) => (a.root === b.root ? a.path.localeCompare(b.path) : a.root.localeCompare(b.root)));

  const reqList = (map: Map<string, Set<string>>): Requirement[] =>
    [...map.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, where]) => ({ name, usedBy: [...where].sort() }));
  for (const r of runtimes) if (!["bash", "sh", "python", "node"].includes(r)) diag("error", "runtime", `Runtime ${r} is not in the runner image`);
  const order = { error: 0, warning: 1, info: 2 } as const;
  diagnostics.sort((a, b) => order[a.severity] - order[b.severity]);
  const created = new Date(now.getTime());
  const manifest: Manifest = {
    schema: SNAPSHOT_SCHEMA,
    name: opts.name.trim(),
    createdAt: created.toISOString(),
    expiresAt: new Date(created.getTime() + opts.expiresInDays * 86_400_000).toISOString(),
    source: { repository: opts.repository, ref: opts.ref, sha },
    entryWorkflows: opts.workflows.map((p) => normalizePath(p)!),
    roots: [...roots.values()].map((r) => ({
      id: r.id,
      repository: r.repository,
      ref: r.ref,
      sha: r.sha,
      kind: r.kind,
      ...(r.gitTree ? { gitTree: r.gitTree, complete: r.omitted === 0 && r.skipped === 0 && r.blobs.size === r.tree.size } : {}),
    })),
    workflows,
    actions: [...actions.values()],
    files,
    requirements: {
      secrets: reqList(secrets),
      variables: reqList(variables),
      inputs,
      runtimes: [...runtimes].sort(),
      externalServices: reqList(services),
    },
    diagnostics,
    totals: { files: files.length, bytes: files.reduce((n, f) => n + f.size, 0) },
  };
  return { manifest, contents };
}
