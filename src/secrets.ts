/**
 * Password storage backed by the OS credential store:
 *  - Windows: Credential Manager (via DPAPI)
 *  - macOS: Keychain
 *  - Linux: Secret Service (gnome-keyring / kwallet via libsecret)
 *
 * Falls back to an in-memory-only prompt (never persisted to disk) if the
 * native keyring module fails to load on an unsupported platform.
 */

const SERVICE = "pi-groupware";

type KeyringEntry = {
  getPassword(): string | null;
  setPassword(password: string): void;
  deleteCredential(): boolean;
};

let entryCtor: (new (service: string, account: string) => KeyringEntry) | undefined;
let loadError: unknown;

async function getEntryCtor() {
  if (entryCtor || loadError) return entryCtor;
  try {
    const mod = await import("@napi-rs/keyring");
    entryCtor = mod.Entry as unknown as new (service: string, account: string) => KeyringEntry;
  } catch (err) {
    loadError = err;
  }
  return entryCtor;
}

export async function keyringAvailable(): Promise<boolean> {
  return (await getEntryCtor()) !== undefined;
}

export async function getPassword(account: string): Promise<string | undefined> {
  const Entry = await getEntryCtor();
  if (!Entry) return undefined;
  try {
    const entry = new Entry(SERVICE, account);
    return entry.getPassword() ?? undefined;
  } catch {
    return undefined;
  }
}

export async function setPassword(account: string, password: string): Promise<void> {
  const Entry = await getEntryCtor();
  if (!Entry) {
    throw new Error(
      "No OS credential store is available on this platform (@napi-rs/keyring failed to load). " +
        "Password cannot be saved persistently.",
    );
  }
  const entry = new Entry(SERVICE, account);
  entry.setPassword(password);
}

export async function deletePassword(account: string): Promise<boolean> {
  const Entry = await getEntryCtor();
  if (!Entry) return false;
  try {
    const entry = new Entry(SERVICE, account);
    return entry.deleteCredential();
  } catch {
    return false;
  }
}
