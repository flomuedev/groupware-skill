import assert from "node:assert/strict";
import test from "node:test";

import { fillTemplate, resolveAccount, type AccountConfig } from "../src/config.ts";

const account: AccountConfig = {
  label: "Test", loginId: "ada", primaryEmail: "Ada@Example.test",
  imapHost: "imap.example.test", imapPort: 993, imapUserTemplate: "ORG\\{id}",
  smtpHost: "smtp.example.test", smtpPort: 465, smtpUserTemplate: "{id}",
  caldavUrlTemplate: "https://calendar.example.test/users/{email}", caldavUserTemplate: "{id}", timezone: "UTC",
};

test("resolveAccount substitutes known template values and normalizes the From address", () => {
  assert.deepEqual(resolveAccount(account), {
    imapUser: "ORG\\ada", smtpUser: "ada", caldavUser: "ada",
    caldavUrl: "https://calendar.example.test/users/ada@example.test", fromAddress: "ada@example.test",
  });
});

test("fillTemplate rejects misspelled variables instead of silently emitting unsafe URLs", () => {
  assert.throws(() => fillTemplate("https://example.test/{emali}", { email: "ada@example.test" }), /Unknown template variable/);
});
