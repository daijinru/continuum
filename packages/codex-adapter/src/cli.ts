import { homedir } from "node:os";
import { delimiter, join } from "node:path";

export function codexEnvironment(): NodeJS.ProcessEnv {
  if (process.platform !== "darwin") return process.env;
  const directories = [
    join(homedir(), "Applications"),
    "/Applications",
  ].flatMap((apps) => [
    join(
      apps,
      "ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS",
    ),
    join(apps, "Codex.app/Contents/Resources"),
  ]);
  return {
    ...process.env,
    PATH: [process.env.PATH ?? "/usr/bin:/bin", ...directories].join(delimiter),
  };
}
