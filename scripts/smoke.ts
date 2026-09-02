// Smoke test: load the extension module with a mock ExtensionAPI to catch
// syntax/type errors and obvious runtime mistakes without needing a full pi session.
import mod from "../src/index.ts";

const registered = { tools: [] as string[], commands: [] as string[] };
const commandHandlers: Record<string, (args: string, ctx: any) => Promise<void>> = {};

const fakeApi = {
  registerTool(def: any) {
    registered.tools.push(def.name);
  },
  registerCommand(name: string, def: any) {
    registered.commands.push(name);
    commandHandlers[name] = def.handler;
  },
  on() {},
  getAllTools() {
    return [];
  },
};

const fakeCtx = {
  cwd: process.cwd(),
  ui: {
    notify(message: string, type = "info") {
      console.log(`[notify:${type}]`, message);
    },
    async confirm() {
      return false;
    },
    async input() {
      return undefined;
    },
    setStatus(key: string, text: string | undefined) {
      console.log(`[status:${key}]`, text);
    },
  },
};

async function main() {
  await (mod as any)(fakeApi);
  console.log("Registered tools:", registered.tools);
  console.log("Registered commands:", registered.commands);

  // Exercise /groupware-status against whatever is (or isn't) configured on this machine.
  await commandHandlers["groupware-status"]?.("", fakeCtx);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
