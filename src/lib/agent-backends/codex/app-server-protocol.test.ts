import { describe, expect, it } from "vitest";
import {
  AppServerRecordDecoder,
  parseAppServerFrame,
  type AppServerFrame,
} from "./app-server-protocol";

describe("Codex app-server framing", () => {
  it("splits only physical LF and preserves split UTF-8 and Unicode separators", () => {
    const frames: AppServerFrame[] = [];
    const decoder = new AppServerRecordDecoder((frame) => frames.push(frame));
    const value = {
      method: "future/notification",
      params: { text: "🙂\u2028\u2029" },
    };
    const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
    for (const byte of bytes) decoder.push(Buffer.from([byte]));
    decoder.finish();
    expect(frames).toEqual([
      {
        raw: JSON.stringify(value),
        byteLength: bytes.length - 1,
        message: { kind: "notification", ...value },
      },
    ]);
  });

  it("checks the record budget per record rather than per read chunk", () => {
    const frames: AppServerFrame[] = [];
    const raw = '{"method":"a"}';
    const decoder = new AppServerRecordDecoder(
      (frame) => frames.push(frame),
      raw.length,
    );
    decoder.push(Buffer.from(`${raw}\n${raw}\n`));
    expect(frames).toHaveLength(2);
  });

  it("rejects an oversized incomplete record before decode or concatenation", () => {
    const decoder = new AppServerRecordDecoder(() => {}, 10);
    decoder.push(Buffer.from("123456"));
    expect(() => decoder.push(Buffer.from("78901"))).toThrow(
      expect.objectContaining({
        code: "record_limit",
        evidence: { byteLength: 11, truncated: true },
      }),
    );
  });

  it("rejects a truncated final record", () => {
    const decoder = new AppServerRecordDecoder(() => {});
    decoder.push(Buffer.from('{"method":"a"}'));
    expect(() => decoder.finish()).toThrow(
      expect.objectContaining({
        code: "protocol_error",
        evidence: { byteLength: 14, truncated: true },
      }),
    );
  });

  it.each([
    '{"id":1}',
    '{"id":1,"result":{},"error":{"code":1,"message":"x"}}',
    '{"id":1,"error":{"message":"x"}}',
    '{"method":3}',
    "[]",
    "not-json",
  ])("rejects malformed envelope %s", (raw) => {
    expect(() => parseAppServerFrame(raw, Buffer.byteLength(raw))).toThrow(
      expect.objectContaining({ code: "protocol_error" }),
    );
  });

  it("keeps server IDs in a different namespace from responses", () => {
    expect(
      parseAppServerFrame('{"id":1,"method":"question","params":{}}', 40)
        .message.kind,
    ).toBe("server_request");
    expect(parseAppServerFrame('{"id":1,"result":null}', 22).message).toEqual({
      kind: "response",
      id: 1,
      result: null,
    });
  });

  it("rejects invalid UTF-8 instead of silently replacing payload bytes", () => {
    const decoder = new AppServerRecordDecoder(() => {});
    expect(() =>
      decoder.push(
        Buffer.concat([
          Buffer.from('{"method":"'),
          Buffer.from([0xff]),
          Buffer.from('"}\n'),
        ]),
      ),
    ).toThrow(expect.objectContaining({ code: "protocol_error" }));
  });
});
