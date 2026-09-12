import { realpath, stat } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

export class WorkspaceViolationError extends Error {
  readonly code = "WORKSPACE_VIOLATION";

  constructor(message: string) {
    super(message);
    this.name = "WorkspaceViolationError";
  }
}

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function assertInside(root: string, candidate: string): void {
  if (!isInside(root, candidate)) {
    throw new WorkspaceViolationError(
      `路径越出授权工作目录：${candidate}（工作目录：${root}）`,
    );
  }
}

export async function resolveWorkspace(input: string): Promise<string> {
  const resolved = resolve(input);
  const info = await stat(resolved);
  if (!info.isDirectory()) {
    throw new WorkspaceViolationError(`工作目录必须是目录：${resolved}`);
  }
  return realpath(resolved);
}

export async function resolveReadPath(
  workspace: string,
  requestedPath: string,
): Promise<string> {
  const candidate = isAbsolute(requestedPath)
    ? resolve(requestedPath)
    : resolve(workspace, requestedPath);
  const realCandidate = await realpath(candidate);
  assertInside(workspace, realCandidate);
  return realCandidate;
}

export async function resolveWritePath(
  workspace: string,
  requestedPath: string,
): Promise<string> {
  const candidate = isAbsolute(requestedPath)
    ? resolve(requestedPath)
    : resolve(workspace, requestedPath);

  try {
    const realCandidate = await realpath(candidate);
    assertInside(workspace, realCandidate);
    return realCandidate;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      throw error;
    }
  }

  const parent = await realpath(dirname(candidate));
  assertInside(workspace, parent);
  const target = join(parent, basename(candidate));
  assertInside(workspace, target);
  return target;
}

export function toWorkspaceRelative(
  workspace: string,
  absolutePath: string,
): string {
  const rel = relative(workspace, absolutePath);
  return rel === "" ? "." : rel.split(sep).join("/");
}
