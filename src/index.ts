import { bootstrap } from "./app/bootstrap.js";

const configPath = process.argv[2];

bootstrap(configPath).catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
