/** One node of the review's file tree: a directory group or a changed file. */
export interface FileTreeNode {
  kind: "dir" | "file";
  /** Label shown in the tree — a collapsed chain keeps its joined path ("a/b/c"). */
  name: string;
  /** Full repo-relative path (files) or directory prefix (directories). */
  path: string;
  children: FileTreeNode[];
}

interface DirDraft {
  dirs: Map<string, DirDraft>;
  files: string[];
}

function emptyDir(): DirDraft {
  return { dirs: new Map(), files: [] };
}

/**
 * Turn the changed paths into a GitLab-style navigation tree: directories first,
 * alphabetical within a level, and a chain of single-child directories collapsed
 * into one row ("packages/core/src") so deep layouts stay readable.
 */
export function buildFileTree(paths: string[]): FileTreeNode[] {
  const root = emptyDir();
  for (const path of paths) {
    const segments = path.split("/").filter(Boolean);
    if (segments.length === 0) continue;
    let cur = root;
    for (const segment of segments.slice(0, -1)) {
      let next = cur.dirs.get(segment);
      if (!next) {
        next = emptyDir();
        cur.dirs.set(segment, next);
      }
      cur = next;
    }
    cur.files.push(segments[segments.length - 1]);
  }
  return levelOf(root, "");
}

function levelOf(dir: DirDraft, prefix: string): FileTreeNode[] {
  const dirs = [...dir.dirs.entries()]
    .map(([name, draft]) => dirNode(name, draft, prefix))
    .sort((a, b) => a.name.localeCompare(b.name));
  const files = dir.files
    .map((name): FileTreeNode => ({
      kind: "file",
      name,
      path: prefix ? `${prefix}/${name}` : name,
      children: [],
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return [...dirs, ...files];
}

/** Build one directory node, folding away every single-child directory below it. */
function dirNode(name: string, draft: DirDraft, prefix: string): FileTreeNode {
  let label = name;
  let path = prefix ? `${prefix}/${name}` : name;
  let cur = draft;
  // Only a directory holding exactly one directory and no files of its own can be
  // merged with its child — anything else is a real branch point.
  while (cur.files.length === 0 && cur.dirs.size === 1) {
    const [childName, child] = [...cur.dirs.entries()][0];
    label = `${label}/${childName}`;
    path = `${path}/${childName}`;
    cur = child;
  }
  return { kind: "dir", name: label, path, children: levelOf(cur, path) };
}
