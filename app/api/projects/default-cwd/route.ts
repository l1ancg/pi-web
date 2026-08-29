import { NextResponse } from "next/server";
import { statSync } from "fs";
import { getDefaultCwd, setDefaultCwd } from "@/lib/project-config";
import { allowFileRoot } from "@/lib/file-access";
import { invalidateSessionListCache } from "@/lib/session-reader";

export const dynamic = "force-dynamic";

// GET /api/projects/default-cwd → { defaultCwd: string | null }
export async function GET() {
  try {
    return NextResponse.json(
      { defaultCwd: getDefaultCwd() },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

// PUT /api/projects/default-cwd  body: { cwd: string | null }
// Configures the directory whose sub-tree is treated as the "Recent" /
// scratch area. Pass `null` (or an empty string) to clear the setting.
// `pi-cwd-*` scratch folders are always allowed regardless of this value.
export async function PUT(req: Request) {
  try {
    const body = await req.json() as { cwd?: unknown };
    if (body.cwd === null || body.cwd === "") {
      const cleared = setDefaultCwd(null);
      invalidateSessionListCache();
      return NextResponse.json({ success: true, defaultCwd: cleared });
    }
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
    const result = setDefaultCwd(cwd);
    if (!result) {
      return NextResponse.json({ error: "cwd is required" }, { status: 400 });
    }
    allowFileRoot(result);
    invalidateSessionListCache();
    return NextResponse.json({ success: true, defaultCwd: result });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
