// Reads the parts of a parsed workflow file that the run graph needs. Pure: takes the YAML parser's output.

export type WorkflowStepDef = { name?: string; uses?: string; run?: string };

export type WorkflowJobDef = {
  id: string;
  /** The job's `name:` (may contain `${{ }}` expressions), if set. */
  name?: string;
  needs: string[];
  /** `strategy.matrix` is present, so the job may expand into several jobs. */
  matrix: boolean;
  /** `uses:` at job level: a reusable workflow call. */
  uses?: string;
  hasIf: boolean;
  /** The raw `if:` expression, when it is a string. */
  ifCondition?: string;
  /** `environment:` (a name, or `{ name }`): the job deploys to a protected environment. */
  environment?: string;
  /** `with:` on a reusable-workflow call: inputs passed to the called workflow, as text (scalars only). */
  with?: Record<string, string>;
  steps: WorkflowStepDef[];
};

export type WorkflowDefinition = { name?: string; jobs: WorkflowJobDef[]; problems: string[] };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown) => (typeof v === "string" ? v : undefined);

export function readWorkflowDefinition(doc: unknown): WorkflowDefinition | { error: string } {
  if (!isRecord(doc)) return { error: "The workflow file is not a YAML mapping" };
  if (!isRecord(doc.jobs)) return { error: "The workflow file has no `jobs` mapping" };
  const problems: string[] = [];
  const jobs: WorkflowJobDef[] = [];
  for (const [id, raw] of Object.entries(doc.jobs)) {
    if (!isRecord(raw)) {
      problems.push(`Job \`${id}\` is not a mapping`);
      continue;
    }
    let needs: string[] = [];
    if (typeof raw.needs === "string") needs = [raw.needs];
    else if (Array.isArray(raw.needs) && raw.needs.every((n) => typeof n === "string")) needs = raw.needs as string[];
    else if (raw.needs !== undefined) problems.push(`Job \`${id}\` has a \`needs\` value that is not a job id or list of ids`);
    const environment = str(raw.environment) ?? (isRecord(raw.environment) ? str(raw.environment.name) : undefined);
    const steps = Array.isArray(raw.steps)
      ? raw.steps.filter(isRecord).map((s): WorkflowStepDef => ({ name: str(s.name), uses: str(s.uses), run: str(s.run) }))
      : [];
    jobs.push({
      id,
      name: str(raw.name),
      needs,
      matrix: isRecord(raw.strategy) && raw.strategy.matrix !== undefined,
      uses: str(raw.uses),
      hasIf: raw.if !== undefined,
      ifCondition: typeof raw.if === "string" ? raw.if : typeof raw.if === "boolean" ? String(raw.if) : undefined,
      environment,
      with: isRecord(raw.with)
        ? Object.fromEntries(
            Object.entries(raw.with)
              .filter(([, v]) => ["string", "number", "boolean"].includes(typeof v))
              .map(([k, v]) => [k, String(v)]),
          )
        : undefined,
      steps,
    });
  }
  return { name: str(doc.name), jobs, problems };
}

/**
 * A job that runs when something upstream failed: `if: failure()`, or a check that a needed job's result is
 * `'failure'` (e.g. `always() && needs.validate.result == 'failure'`), possibly within a larger expression.
 */
export function runsOnFailure(def: WorkflowJobDef): boolean {
  return !!def.ifCondition && /\bfailure\(\)|\bneeds\.[\w-]+\.result\s*==\s*['"]failure['"]/.test(def.ifCondition);
}

/** The display name GitHub gives a step that has no `name:`. */
export function defaultStepName(step: WorkflowStepDef): string | undefined {
  if (step.name) return step.name;
  if (step.uses) return `Run ${step.uses}`;
  if (step.run) return `Run ${step.run.split("\n")[0]!.trim()}`;
  return undefined;
}

/** `uses:` that is not one of GitHub's own `actions/*`: a repository-local or organisation action. */
export function isCustomAction(uses: string | undefined): boolean {
  return !!uses && !uses.startsWith("actions/") && !uses.startsWith("docker://");
}
