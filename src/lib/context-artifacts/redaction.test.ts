import { describe, expect, it } from "vitest";
import { redactEnvelopeStrings, redactText } from "./redaction";

describe("redactText", () => {
  const shouldRedactCases: Array<{
    name: string;
    input: string;
    mustNotContain: string[];
  }> = [
    {
      name: "aws-key",
      input: "export AWS_ACCESS_KEY_ID=AKIAABCDEFGHIJKLMNOP",
      mustNotContain: ["AKIAABCDEFGHIJKLMNOP"],
    },
    {
      name: "aws-key (ASIA session key)",
      input: "temp key: ASIA1234567890ABCDEF",
      mustNotContain: ["ASIA1234567890ABCDEF"],
    },
    {
      name: "bearer token",
      input: "curl -H 'Authorization: Bearer sk-live-abc123DEF456ghi789JKL012'",
      mustNotContain: ["sk-live-abc123DEF456ghi789JKL012"],
    },
    {
      name: "pem block",
      input:
        "-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAKj34GkxFhD91aM8xXwr\n-----END RSA PRIVATE KEY-----",
      mustNotContain: [
        "MIIBOgIBAAJBAKj34GkxFhD91aM8xXwr",
        "BEGIN RSA PRIVATE KEY",
      ],
    },
    {
      name: "password assignment",
      input: 'password = "Sup3rSecretPassw0rd!"',
      mustNotContain: ["Sup3rSecretPassw0rd!"],
    },
    {
      name: "token assignment (colon)",
      input: "token: 'gh1qzX9mLp3vR7tKw2eBn8s'",
      mustNotContain: ["gh1qzX9mLp3vR7tKw2eBn8s"],
    },
    {
      name: "secret assignment (bare)",
      input: "client_secret=Z8x2Kq9mNv4pLr6Wj3Ye",
      mustNotContain: ["Z8x2Kq9mNv4pLr6Wj3Ye"],
    },
    {
      name: "api_key assignment",
      input: "api_key = 4f8a2c9e1b7d6534fa021ce98877bb12",
      mustNotContain: ["4f8a2c9e1b7d6534fa021ce98877bb12"],
    },
    {
      name: "github personal access token (ghp_)",
      input:
        "remote set-url origin https://ghp_1234567890abcdefghijKLMNOPQRSTuvwxyz@github.com/x/y.git",
      mustNotContain: ["ghp_1234567890abcdefghijKLMNOPQRSTuvwxyz"],
    },
    {
      name: "github fine-grained token (github_pat_)",
      input:
        "GITHUB_TOKEN=github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz0123456789",
      mustNotContain: [
        "github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz0123456789",
      ],
    },
    {
      name: "openai-style api key (sk-)",
      input: "OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz0123456789",
      mustNotContain: ["sk-proj-abcdefghijklmnopqrstuvwxyz0123456789"],
    },
    {
      name: "anthropic-style api key (sk-ant-)",
      input:
        "ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789",
      mustNotContain: ["sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789"],
    },
    {
      name: "slack bot token",
      input: "SLACK_BOT_TOKEN=xoxb-1234567890-abcdefghijklmnop",
      mustNotContain: ["xoxb-1234567890-abcdefghijklmnop"],
    },
    {
      name: "slack app token",
      input: "SLACK_APP_TOKEN=xoxa-2345678901-qrstuvwxyzabcdef",
      mustNotContain: ["xoxa-2345678901-qrstuvwxyzabcdef"],
    },
    {
      name: "jwt (standalone)",
      input:
        "session cookie: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
      mustNotContain: [
        "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
      ],
    },
    {
      name: "generic hex secret assigned to *Key variable",
      input:
        "signingKey = 3fa8b2c19de04a5e8b6c7d1029384756afbecd0123456789abcdef012345678",
      mustNotContain: [
        "3fa8b2c19de04a5e8b6c7d1029384756afbecd0123456789abcdef012345678",
      ],
    },
    {
      name: "generic base64 secret assigned to *_token variable",
      input:
        "refresh_token: 'QWxhZGRpbjpvcGVuIHNlc2FtZQ==QWxhZGRpbjpvcGVuIHNlc2FtZQ=='",
      mustNotContain: [
        "QWxhZGRpbjpvcGVuIHNlc2FtZQ==QWxhZGRpbjpvcGVuIHNlc2FtZQ==",
      ],
    },
    {
      name: "JSON-quoted password key",
      input: '{"password": "S3cr3t!Pass-2024"}',
      mustNotContain: ["S3cr3t!Pass-2024"],
    },
    {
      name: "JSON-quoted api_key",
      input: '{"api_key": "9f8e7d6c5b4a39281706f5e4d3c2b1a0"}',
      mustNotContain: ["9f8e7d6c5b4a39281706f5e4d3c2b1a0"],
    },
    {
      name: "JSON-quoted aws_secret_access_key",
      input:
        '{"aws_secret_access_key": "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"}',
      mustNotContain: ["wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"],
    },
  ];

  it.each(shouldRedactCases)("redacts $name", ({ input, mustNotContain }) => {
    const result = redactText(input);
    for (const secret of mustNotContain) {
      expect(result).not.toContain(secret);
    }
    expect(result).toContain("[REDACTED:");
  });

  const mustNotRedactCases: Array<{ name: string; input: string }> = [
    {
      name: "ordinary code identifier assignment",
      input: "const token = await fetchToken();",
    },
    {
      name: "short numeric assignment",
      input: "const id = 1;\nconst x = 42;",
    },
    {
      name: "file path mentioning secret/password",
      input: "/Users/alex/projects/command-center/secrets/passwords.txt",
    },
    {
      name: "prose mentioning password and token",
      input:
        "Never share your password or API token with anyone, even support staff.",
    },
    {
      name: "prose describing a bearer scheme without a token",
      input: "The API uses Bearer authentication for all requests.",
    },
    {
      name: "short bare secret assignment",
      input: "pwd=abc",
    },
    {
      name: "boolean-like assignment on a key-shaped name",
      input: "hasApiKey = true",
    },
    {
      name: "normal variable name containing 'key' as a substring",
      input: "const monkeyCount = 3;\nconst keyboardLayout = 'qwerty';",
    },
    {
      name: "ordinary function call assigned to a secret-shaped name",
      input: "const secretSauce = computeSecretSauce(recipe);",
    },
    {
      name: "ordinary JSON with a non-credential key",
      input: '{"path": "/usr/bin"}',
    },
    {
      name: "JSON key containing 'token' with a trivial value",
      input: '{"tokenizer": "gpt2"}',
    },
  ];

  it.each(mustNotRedactCases)("does not redact: $name", ({ input }) => {
    expect(redactText(input)).toBe(input);
  });

  it("is idempotent on already-redacted text", () => {
    const input = 'password = "Sup3rSecretPassw0rd!"';
    const once = redactText(input);
    const twice = redactText(once);
    expect(twice).toBe(once);
  });

  it("redacts multiple distinct secrets in the same text", () => {
    const input = [
      "AWS_ACCESS_KEY_ID=AKIAABCDEFGHIJKLMNOP",
      'password = "Sup3rSecretPassw0rd!"',
    ].join("\n");
    const result = redactText(input);
    expect(result).not.toContain("AKIAABCDEFGHIJKLMNOP");
    expect(result).not.toContain("Sup3rSecretPassw0rd!");
  });
});

describe("redactEnvelopeStrings", () => {
  it("deep-walks nested objects and arrays, redacting only string leaves", () => {
    const value = {
      agentBrief: 'auth uses password = "Sup3rSecretPassw0rd!" in .env',
      decisions: [
        {
          statement: "use AKIAABCDEFGHIJKLMNOP for prod bucket access",
          sourceRefs: ["m12"],
        },
      ],
      coverage: { startSeq: 0, endSeq: 42 },
      metadata: null,
      flags: { verbose: true },
    };

    const result = redactEnvelopeStrings(value);

    expect(result.agentBrief).not.toContain("Sup3rSecretPassw0rd!");
    expect(result.decisions[0]?.statement).not.toContain(
      "AKIAABCDEFGHIJKLMNOP",
    );
    expect(result.decisions[0]?.sourceRefs).toEqual(["m12"]);
    expect(result.coverage).toEqual({ startSeq: 0, endSeq: 42 });
    expect(result.metadata).toBeNull();
    expect(result.flags).toEqual({ verbose: true });
  });

  it("preserves array order and length", () => {
    const value = { items: ["a", "b", "c"] };
    const result = redactEnvelopeStrings(value);
    expect(result.items).toEqual(["a", "b", "c"]);
  });

  it("leaves non-secret strings untouched", () => {
    const value = { note: "no secrets here", count: 3 };
    const result = redactEnvelopeStrings(value);
    expect(result).toEqual(value);
  });
});
