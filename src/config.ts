import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Non-secret account configuration. Never store passwords in here. */
export interface AccountConfig {
  /** Display label, e.g. "TU Darmstadt". */
  label: string;
  /** University/organization login id (e.g. TU-ID). Used to derive protocol usernames. */
  loginId: string;
  /** Primary mailbox address, lowercase. Used as SMTP "From" and in the CalDAV URL. */
  primaryEmail: string;

  imapHost: string;
  imapPort: number;
  /** Username template for IMAP. "{id}" is replaced with loginId. */
  imapUserTemplate: string;

  smtpHost: string;
  smtpPort: number;
  smtpUserTemplate: string;

  /** CalDAV base URL template. "{email}" is replaced with the lowercase primary email. */
  caldavUrlTemplate: string;
  caldavUserTemplate: string;

  timezone: string;

  /** Discovered/confirmed special-use folder names (server-side real names). */
  folders?: {
    inbox?: string;
    sent?: string;
    drafts?: string;
    trash?: string;
  };
}

export const TU_DARMSTADT_DEFAULTS: Omit<AccountConfig, "loginId" | "primaryEmail" | "folders"> = {
  label: "TU Darmstadt",
  imapHost: "mail.tu-darmstadt.de",
  imapPort: 993,
  imapUserTemplate: "ADS\\{id}",
  smtpHost: "smtp.tu-darmstadt.de",
  smtpPort: 465,
  smtpUserTemplate: "{id}",
  caldavUrlTemplate: "https://mail.tu-darmstadt.de:1443/users/{email}/calendar",
  caldavUserTemplate: "{id}",
  timezone: "Europe/Berlin",
};

export interface RootConfig {
  /** Currently only one account is supported end-to-end, but stored as a list for future growth. */
  accounts: AccountConfig[];
  defaultAccount?: string;
}

function configDir(): string {
  return join(homedir(), ".pi-groupware");
}

function configPath(): string {
  return join(configDir(), "config.json");
}

export async function loadConfig(): Promise<RootConfig> {
  try {
    const raw = await readFile(configPath(), "utf8");
    const parsed = JSON.parse(raw) as RootConfig;
    if (!Array.isArray(parsed.accounts)) return { accounts: [] };
    return parsed;
  } catch {
    return { accounts: [] };
  }
}

export async function saveConfig(config: RootConfig): Promise<void> {
  await mkdir(dirname(configPath()), { recursive: true });
  await writeFile(configPath(), JSON.stringify(config, null, 2), "utf8");
}

export async function getDefaultAccount(): Promise<AccountConfig | undefined> {
  const config = await loadConfig();
  if (config.accounts.length === 0) return undefined;
  if (config.defaultAccount) {
    const found = config.accounts.find((a) => a.primaryEmail === config.defaultAccount);
    if (found) return found;
  }
  return config.accounts[0];
}

export async function upsertAccount(account: AccountConfig): Promise<void> {
  const config = await loadConfig();
  const idx = config.accounts.findIndex((a) => a.primaryEmail === account.primaryEmail);
  if (idx >= 0) config.accounts[idx] = account;
  else config.accounts.push(account);
  config.defaultAccount ??= account.primaryEmail;
  await saveConfig(config);
}

export function fillTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, key) => values[key] ?? "");
}

export function resolveAccount(account: AccountConfig) {
  const email = account.primaryEmail.toLowerCase();
  return {
    imapUser: fillTemplate(account.imapUserTemplate, { id: account.loginId }),
    smtpUser: fillTemplate(account.smtpUserTemplate, { id: account.loginId }),
    caldavUser: fillTemplate(account.caldavUserTemplate, { id: account.loginId }),
    caldavUrl: fillTemplate(account.caldavUrlTemplate, { id: account.loginId, email }),
    fromAddress: email,
  };
}
