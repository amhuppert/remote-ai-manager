import { describe, expect, it } from "vitest";
import {
  ambientCredentialKeys,
  isCredentialShapedEnvKey,
  withoutAmbientCredentials,
} from "./credential-env";

/**
 * The rule deciding which inherited environment variables never reach a Cursor
 * worker (spec R6.2).
 *
 * One owner for two consumers: the supervisor strips exactly what the
 * acceptance suite scans for, so the suite cannot report a boundary clean on a
 * narrower definition than the one production applied.
 */

describe("isCredentialShapedEnvKey", () => {
  it("recognises the spellings a credential variable is given", () => {
    for (const key of [
      "OPENAI_API_KEY",
      "ELEVENLABS_API_KEY",
      "GEMINI_APIKEY",
      "GITHUB_TOKEN",
      "CC_API_TOKEN",
      "AWS_SECRET_ACCESS_KEY",
      "PGPASSWORD",
      "GOOGLE_APPLICATION_CREDENTIALS",
      "CURSOR_API_KEY",
    ]) {
      expect(isCredentialShapedEnvKey(key), key).toBe(true);
    }
  });

  it("leaves the variables an agent needs to do its job", () => {
    // Over-stripping is its own failure: a worker without PATH or HOME cannot
    // run a shell tool at all.
    for (const key of [
      "PATH",
      "HOME",
      "NODE_ENV",
      "LANG",
      "TERM",
      "CC_SESSION",
      "CC_PROJECT",
      "CC_SERVER_URL",
      "KEYBOARD_LAYOUT",
    ]) {
      expect(isCredentialShapedEnvKey(key), key).toBe(false);
    }
  });
});

describe("withoutAmbientCredentials", () => {
  it("drops credential-shaped variables and keeps everything else", () => {
    expect(
      withoutAmbientCredentials({
        PATH: "/usr/bin",
        HOME: "/home/alex",
        OPENAI_API_KEY: "sk-ambient",
        GITHUB_TOKEN: "ghp_ambient",
      }),
    ).toEqual({ PATH: "/usr/bin", HOME: "/home/alex" });
  });

  it("drops the key even when its value is empty, so nothing is inherited", () => {
    expect(withoutAmbientCredentials({ OPENAI_API_KEY: "" })).toEqual({});
  });

  it("does not mutate the environment it was given", () => {
    const source = { OPENAI_API_KEY: "sk-ambient" };
    withoutAmbientCredentials(source);
    expect(source).toEqual({ OPENAI_API_KEY: "sk-ambient" });
  });
});

describe("ambientCredentialKeys", () => {
  it("reports the names that were dropped, never their values", () => {
    const keys = ambientCredentialKeys({
      PATH: "/usr/bin",
      OPENAI_API_KEY: "sk-ambient",
      GITHUB_TOKEN: "ghp_ambient",
    });

    expect([...keys].sort()).toEqual(["GITHUB_TOKEN", "OPENAI_API_KEY"]);
  });
});
