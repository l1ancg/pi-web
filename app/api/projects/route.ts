import { NextResponse } from "next/server";
import { statSync } from "fs";
import {
  addConfiguredProject,
  getConfiguredProjects,
  getDefaultCwd,
  isCwdConfigured,
} from "@/lib/project-config";
import { allowFileRoot } from "@/lib/file-access";
import { invalidateSessionListCache } from "@/lib/session-reader";
import { resolveProject } from "@/lib/worktree";
import { projectIdentityKey } from "@/lib/project-identity";

export const dynamic = "force-dynamic";

// GET /api/projects → { projects: [...], defaultCwd: string | null }
export async function GET() {
  try {
    const projects = getConfiguredProjects();
    const enriched = await Promise.all(
      projects.map(async (project) => {
        const projectInfo = await resolveProject(project.cwd).catch(() => null);
        const projectRoot = projectInfo?.projectRoot ?? project.cwd;
        return {
          cwd: project.cwd,
          addedAt: project.addedAt,
          projectRoot,
          projectKey: projectIdentityKey(projectRoot),
          ...(projectInfo?.branch ? { branch: projectInfo.branch } : {}),
          ...(projectInfo?.isWorktree ? { isWorktree: true } : {}),
        };
      }),
    );
    return NextResponse.json(
      { projects: enriched, defaultCwd: getDefaultCwd() },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

// POST /api/projects  body: { cwd: string }
// Registers a cwd as a project. Idempotent — the same cwd always returns the
// same entry, so clients can retry safely.
export async function POST(req: Request) {
  try {
    const body = await req.json() as { cwd?: unknown };
    const cwd = typeof body.cwd === "string" ? body.cwd.trim() : "";
    if (!cwd) {
      return NextResponse.json({ error: "cwd is required" }, { status: 400 });
    }
    let stat;
    try {
      stat = statSync(cwd);
    } catch {
      return NextResponse.json({ error: `Directory does not exist: ${cwd}` }, { status: 400 });
    }
    if (!stat.isDirectory()) {
      return NextResponse.json({ error: `Path is not a directory: ${cwd}` }, { status: 400 });
    }

    const alreadyExisted = isCwdConfigured(cwd);
    const entry = addConfiguredProject(cwd);
    // Allow the file viewer / worktrees endpoint to read the directory.
    allowFileRoot(entry.cwd);
    invalidateSessionListCache();
    const projectInfo = await resolveProject(entry.cwd).catch(() => null);
    const projectRoot = projectInfo?.projectRoot ?? entry.cwd;
    return NextResponse.json({
      success: true,
      alreadyExisted,
      project: {
        cwd: entry.cwd,
        addedAt: entry.addedAt,
        projectRoot,
        projectKey: projectIdentityKey(projectRoot),
        ...(projectInfo?.branch ? { branch: projectInfo.branch } : {}),
        ...(projectInfo?.isWorktree ? { isWorktree: true } : {}),
      },
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
