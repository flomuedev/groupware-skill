import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerGroupwareTools } from "./tools.ts";
import { registerSetupCommands } from "./setup.ts";
import { getDefaultAccount } from "./config.ts";
import { getPassword } from "./secrets.ts";

export default function (pi: ExtensionAPI) {
  registerSetupCommands(pi);
  registerGroupwareTools(pi);

  pi.on("session_start", async (_event, ctx) => {
    const account = await getDefaultAccount();
    if (!account) {
      ctx.ui.setStatus("pi-groupware", "not configured — run /groupware-setup");
      return;
    }
    const password = await getPassword(account.primaryEmail);
    ctx.ui.setStatus("pi-groupware", password ? `${account.primaryEmail}` : `${account.primaryEmail} (no saved password)`);
  });
}
