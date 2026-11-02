// Git object IDs computed from content (security review H1): a file's blob ID and a directory's tree ID, exactly as
// git computes them. They bind packaged content to the Git objects GitHub reported at preparation, so the executor
// and runner can check offline that a snapshot's files are byte-for-byte a given Git tree. Pure: Web Crypto only.

const enc = new TextEncoder();

async function sha1(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-1", data as BufferSource));
}
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const unhex = (h: string) => Uint8Array.from(h.match(/../g)!.map((x) => parseInt(x, 16)));
const concat = (parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

/** git hash-object: sha1("blob <size>\0" + content). */
export async function gitBlobId(content: Uint8Array): Promise<string> {
  return hex(await sha1(concat([enc.encode(`blob ${content.length}\0`), content])));
}

export type GitTreeEntry = { path: string; blob: string; executable: boolean };

/**
 * The tree ID of a set of regular files (modes 100644 and 100755), built bottom-up like git: entries sorted by name,
 * where a directory sorts as if its name ended in "/". Symlinks and submodules are not representable here, so a
 * tree that has them can't be recomputed (prepare.ts records such roots as incomplete).
 */
export async function gitTreeId(entries: GitTreeEntry[]): Promise<string> {
  type Dir = { files: Map<string, GitTreeEntry>; dirs: Map<string, Dir> };
  const root: Dir = { files: new Map(), dirs: new Map() };
  for (const e of entries) {
    const parts = e.path.split("/");
    let d = root;
    for (const p of parts.slice(0, -1)) {
      if (!d.dirs.has(p)) d.dirs.set(p, { files: new Map(), dirs: new Map() });
      d = d.dirs.get(p)!;
    }
    d.files.set(parts.at(-1)!, e);
  }
  const hashDir = async (d: Dir): Promise<string> => {
    const items: { sortKey: string; bytes: Uint8Array }[] = [];
    for (const [name, f] of d.files) items.push({ sortKey: name, bytes: concat([enc.encode(`${f.executable ? "100755" : "100644"} ${name}\0`), unhex(f.blob)]) });
    for (const [name, sub] of d.dirs) items.push({ sortKey: `${name}/`, bytes: concat([enc.encode(`40000 ${name}\0`), unhex(await hashDir(sub))]) });
    // git compares raw bytes; UTF-8 byte order equals code-point order, which this comparison follows.
    items.sort((a, b) => compareBytes(enc.encode(a.sortKey), enc.encode(b.sortKey)));
    const body = concat(items.map((i) => i.bytes));
    return hex(await sha1(concat([enc.encode(`tree ${body.length}\0`), body])));
  };
  return hashDir(root);
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return a.length - b.length;
}

export const GIT_ID = /^[0-9a-f]{40}$/;
