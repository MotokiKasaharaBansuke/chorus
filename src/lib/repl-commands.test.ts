import { describe, it, expect } from "vitest";
import { REPL_COMMANDS, matchReplCommand } from "./repl-commands";

describe("REPL_COMMANDS", () => {
  it("defines login command mapping to claude auth login", () => {
    const def = REPL_COMMANDS["login"];
    expect(def).toBeDefined();
    expect(def.command).toBe("claude");
    expect(def.args).toEqual(["auth", "login"]);
    expect(def.title).toBe("Login");
  });

  it("defines logout command mapping to claude auth logout", () => {
    const def = REPL_COMMANDS["logout"];
    expect(def).toBeDefined();
    expect(def.command).toBe("claude");
    expect(def.args).toEqual(["auth", "logout"]);
  });

  it("defines doctor command mapping to claude doctor", () => {
    const def = REPL_COMMANDS["doctor"];
    expect(def).toBeDefined();
    expect(def.command).toBe("claude");
    expect(def.args).toEqual(["doctor"]);
  });

  it("defines status command mapping to claude auth status", () => {
    const def = REPL_COMMANDS["status"];
    expect(def).toBeDefined();
    expect(def.command).toBe("claude");
    expect(def.args).toEqual(["auth", "status"]);
  });
});

describe("matchReplCommand", () => {
  it("matches /login", () => {
    expect(matchReplCommand("/login")).toBe("login");
  });

  it("matches /logout", () => {
    expect(matchReplCommand("/logout")).toBe("logout");
  });

  it("matches /doctor", () => {
    expect(matchReplCommand("/doctor")).toBe("doctor");
  });

  it("matches /status", () => {
    expect(matchReplCommand("/status")).toBe("status");
  });

  it("matches with leading/trailing whitespace", () => {
    expect(matchReplCommand("  /login  ")).toBe("login");
  });

  it("returns undefined for non-REPL commands", () => {
    expect(matchReplCommand("/compact")).toBeUndefined();
    expect(matchReplCommand("/review")).toBeUndefined();
  });

  it("returns undefined for regular text", () => {
    expect(matchReplCommand("hello world")).toBeUndefined();
    expect(matchReplCommand("")).toBeUndefined();
  });

  it("returns undefined for just a slash", () => {
    expect(matchReplCommand("/")).toBeUndefined();
  });

  it("ignores trailing arguments after the command", () => {
    expect(matchReplCommand("/login --sso")).toBe("login");
  });
});
