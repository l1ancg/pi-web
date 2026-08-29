import { NextResponse } from "next/server";
import { removeConfiguredProject } from "@/lib/project-config";
import { invalidateSessionListCache } from "@/lib/session-reader";

export const dynamic = "force-dynamic";

// DELETE /api/projects/[cwd]
// Unregisters a cwd from the project list. Sessions on disk are left alone;
// they will simply stop appearing in /api/sessions.
export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ cwd: string }> },
) {
  try {
    const { cwd } = await ctx.params;
    if (!cwd) {
      return NextResponse.json({ error: "cwd is required" }, { status: 400 });
    }
    const removed = removeConfiguredProject(decodeURIComponent(cwd));
    if (!removed) {
      return NextResponse.json({ error: "Project not found", removed: false }, { status: 404 });
    }
    invalidateSessionListCache();
    return NextResponse.json({ success: true, removed: true });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
