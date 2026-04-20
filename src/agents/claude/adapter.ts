import type { ChildProcess } from "node:child_process";
import { createWriteStream, type WriteStream } from "node:fs";

import type { AgentKind, AgentSandboxMode } from "../../config/types.js";
import { RunAdapter, type BuildArgsContext } from "../run-adapter.js";

export class ClaudeAdapter extends RunAdapter {
  readonly id: AgentKind = "claude";

  protected async buildArgs({ prompt }: BuildArgsContext): Promise<string[]> {
    const args = ["-p", "--output-format", "text"];
    const permissionMode = mapSandboxToPermissionMode(this.config.sandboxMode);
    if (permissionMode) {
      args.push("--permission-mode", permissionMode);
    }
    args.push(prompt);
    return args;
  }

  protected attachStdio(
    child: ChildProcess,
    outputStream: WriteStream,
    lastMessagePath: string,
  ): (() => void) | undefined {
    // claude -p prints the reply to stdout. Tee into the log (stdout+stderr
    // combined) and a dedicated last-message file so status queries and
    // notifications can quote the reply without parsing the log.
    const lastMessageStream = createWriteStream(lastMessagePath, { flags: "w" });
    child.stdout?.on("data", (chunk) => {
      outputStream.write(chunk);
      lastMessageStream.write(chunk);
    });
    child.stderr?.pipe(outputStream);
    return () => lastMessageStream.end();
  }
}

function mapSandboxToPermissionMode(mode: AgentSandboxMode | undefined): string | undefined {
  switch (mode) {
    case "danger-full-access":
      return "bypassPermissions";
    case "workspace-write":
      return "acceptEdits";
    case "read-only":
      return "plan";
    default:
      return undefined;
  }
}
