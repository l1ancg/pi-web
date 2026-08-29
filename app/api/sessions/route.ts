import { NextResponse } from "next/server";
import { homedir } from "os";
import {
  attachSessionProjectInfo,
  listAllSessions,
  mergeSessionLists,
} from "@/lib/session-reader";
import {
  getCompletionNotificationSuppressedRpcSessionIds,
  getRpcSessionInfos,
  getRunningRpcSessionIds,
} from "@/lib/rpc-manager";
import { isSessionInConfiguredProjects } from "@/lib/project-config";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const force = new URL(req.url).searchParams.get("force") === "1";
    const [persistedSessions, runtimeSessions] = await Promise.all([
      listAllSessions({ force }),
      attachSessionProjectInfo(getRpcSessionInfos()),
    ]);
    const merged = mergeSessionLists(persistedSessions, runtimeSessions);
    // Only show sessions whose cwd / projectRoot is a configured project,
    // plus any pi-cwd-* scratch roots. This makes the project list reflect
    // exactly the directories the user registered in conf.json.
    const home = homedir();
    const sessions = merged.filter((session) =>
      isSessionInConfiguredProjects(session.cwd, session.projectRoot, home),
    );
    return NextResponse.json(
      {
        sessions,
        runningSessionIds: getRunningRpcSessionIds(),
        completionNotificationSuppressedSessionIds: getCompletionNotificationSuppressedRpcSessionIds(),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return NextResponse.json(
      { error: String(error) },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
