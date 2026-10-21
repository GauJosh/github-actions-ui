// Loads a run's reusable-workflow hierarchy: every called workflow file, at the revision the run used, read-only.
// Bounded: at most TREE_LIMITS.depth levels, TREE_LIMITS.files distinct files per run, and
// TREE_LIMITS.concurrency requests at a time. Files at a commit never change, so they are cached for the session
// (in memory only). A call whose revision cannot be established is not read (see resolveCall). Logs are never
// fetched here.
import type { WorkflowFileRef } from "../domain/graph/build";
import { fileKey, resolveCall, type WorkflowTree } from "../domain/graph/hierarchy";
import { readWorkflowDefinition, type WorkflowDefinition } from "../domain/graph/workflow-definition";
import type { Run } from "../domain/types";
import { GitHubError, type GitHubClient } from "../github/client";

export const TREE_LIMITS = { depth: 10, files: 40, concurrency: 4 };
const CACHE_ENTRIES = 200;

export type FileRead = { definition: WorkflowDefinition } | { unavailable: string; rateLimited?: boolean };
const cache = new WeakMap<GitHubClient, Map<string, Promise<FileRead>>>();

/** Reads and parses one workflow file at an exact revision. Successful reads are cached per client. */
export function readWorkflowAt(client: GitHubClient, file: Pick<WorkflowFileRef, "repo" | "path" | "revision">): Promise<FileRead> {
  let entries = cache.get(client);
  if (!entries) cache.set(client, (entries = new Map()));
  const key = fileKey(file);
  const hit = entries.get(key);
  if (hit) return hit;
  const name = `${file.repo}/${file.path}`;
  const read = (async (): Promise<FileRead> => {
    const [owner, repo] = file.repo.split("/") as [string, string];
    let text: string;
    try {
      text = await client.getWorkflowFile({ owner, repo }, file.path, file.revision);
    } catch (error) {
      entries.delete(key); // failures are not cached: a retry may succeed
      if (!(error instanceof GitHubError)) return { unavailable: `${name} could not be read.` };
      switch (error.failure.kind) {
        case "permission":
        case "auth-failed":
          return { unavailable: `The token cannot read ${name} (it needs Contents: Read on ${file.repo}).` };
        case "not-found-or-no-permission":
          return { unavailable: `${name} was not found at ${file.revision.slice(0, 7)}, or the token cannot read ${file.repo}.` };
        case "rate-limited":
          return { unavailable: `GitHub's rate limit was reached before ${name} could be read.`, rateLimited: true };
        default:
          return { unavailable: `${name} could not be read.` };
      }
    }
    try {
      const definition = readWorkflowDefinition((await import("yaml")).parse(text));
      return "error" in definition ? { unavailable: `${name}: ${definition.error}.` } : { definition };
    } catch {
      return { unavailable: `${name} is not valid YAML.` };
    }
  })();
  entries.set(key, read);
  if (entries.size > CACHE_ENTRIES) entries.delete(entries.keys().next().value!);
  return read;
}

export type TreeStats = { filesRead: number; limitsReached: string[] };

async function pool(tasks: (() => Promise<void>)[], size: number): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) await tasks[next++]!();
  };
  await Promise.all(Array.from({ length: Math.min(size, tasks.length) }, worker));
}

/** The run's workflow and, recursively, the workflows it calls (breadth first). */
export async function loadWorkflowTree(
  client: GitHubClient,
  run: Pick<Run, "referenced_workflows">,
  root: { definition: WorkflowDefinition; file: WorkflowFileRef },
): Promise<{ tree: WorkflowTree; stats: TreeStats }> {
  const tree: WorkflowTree = { file: root.file, definition: root.definition, calls: new Map() };
  const distinct = new Set<string>();
  const limitsReached = new Set<string>();
  let rateLimited = false;
  let frontier = [{ node: tree, depth: 0, ancestry: [fileKey(root.file)] }];

  while (frontier.length) {
    const tasks: (() => Promise<void>)[] = [];
    const next: typeof frontier = [];
    for (const { node, depth, ancestry } of frontier) {
      for (const job of node.definition?.jobs ?? []) {
        if (!job.uses) continue;
        const resolved = resolveCall(job.uses, node.file!, run.referenced_workflows);
        if ("unresolved" in resolved) {
          node.calls.set(job.id, { definition: null, unavailable: resolved.unresolved, calls: new Map() });
          continue;
        }
        const child: WorkflowTree = { file: resolved.file, definition: null, calls: new Map() };
        node.calls.set(job.id, child);
        const key = fileKey(resolved.file);
        const name = `${resolved.file.repo}/${resolved.file.path}`;
        if (ancestry.includes(key)) {
          child.unavailable = `${name} calls itself (directly or through other workflows), so it is not expanded again.`;
          continue;
        }
        if (depth + 1 > TREE_LIMITS.depth) {
          child.unavailable = `Not read: more than ${TREE_LIMITS.depth} levels of nested calls.`;
          limitsReached.add("depth");
          continue;
        }
        if (!distinct.has(key) && distinct.size >= TREE_LIMITS.files) {
          child.unavailable = `Not read: this run references more than ${TREE_LIMITS.files} workflow files.`;
          limitsReached.add("files");
          continue;
        }
        distinct.add(key);
        tasks.push(async () => {
          if (rateLimited) {
            child.unavailable = `Not read: GitHub's rate limit was reached.`;
            return;
          }
          const read = await readWorkflowAt(client, resolved.file);
          if ("definition" in read) {
            child.definition = read.definition;
            next.push({ node: child, depth: depth + 1, ancestry: [...ancestry, key] });
          } else {
            child.unavailable = read.unavailable;
            if (read.rateLimited) rateLimited = true;
          }
        });
      }
    }
    await pool(tasks, TREE_LIMITS.concurrency);
    frontier = next;
  }
  return { tree, stats: { filesRead: distinct.size, limitsReached: [...limitsReached] } };
}
