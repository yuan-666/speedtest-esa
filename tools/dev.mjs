import { spawn } from "node:child_process";

const children = [
  spawn("npm", ["run", "dev:api"], { stdio: "inherit" }),
  spawn("npm", ["run", "dev:web"], { stdio: "inherit" })
];

function shutdown(signal) {
  for (const child of children) child.kill(signal);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

const [api, web] = children;
api.on("exit", (code) => {
  if (code) process.exit(code);
});
web.on("exit", (code) => {
  if (code) process.exit(code);
});
