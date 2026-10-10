import { FakeSystem } from "./phibot-fake-system.js";

/** A fresh Ubuntu server seen as root through `sudo npx`: NodeSource node and npm, systemd, apt. */
export function goodHost(): FakeSystem {
  return new FakeSystem()
    .addDir("/run/systemd/system")
    .addFile("/usr/bin/apt-get", "")
    .addFile("/usr/bin/npm", "")
    .onExec("/usr/bin/npm root -g", { code: 0, stdout: "/usr/lib/node_modules\n", stderr: "" })
    .onExec("getent ahosts", { code: 0, stdout: "203.0.113.7 STREAM bot.exemple.fr\n", stderr: "" });
}
