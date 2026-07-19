import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDangerousCommandDetector,
  type DangerousCommandDetector,
} from "../../src/policy/dangerous-command.ts";

describe("Codex-compatible dangerous command detection", () => {
  let detector: DangerousCommandDetector;

  beforeAll(async () => {
    detector = await createDangerousCommandDetector();
  });

  afterAll(() => {
    detector.close();
  });

  it("matches the pinned Codex forced-rm variants", () => {
    for (const command of [
      "/bin/rm -fr /tmp/example",
      "rm -r -f /tmp/example",
      "rm --force /tmp/example",
      "rm /tmp/example -f",
      "sudo rm -rf /tmp/example",
      "env TARGET=/tmp/example rm -rf /tmp/example",
    ]) {
      expect(detector.detect(command), command).toBe("forced-rm");
    }
  });

  it("matches forced rm nested in valid complex shell syntax", () => {
    for (const command of [
      "printf x | rm -rf /tmp/example",
      "if test -d /tmp/example; then rm --force /tmp/example; fi",
      'rm -rf "$TARGET" >/dev/null',
      'for target in /tmp/a /tmp/b; do rm -r -f "$target"; done',
      'echo "$(rm -rf /tmp/example)"',
      "bash -c 'rm -rf /tmp/example'",
      "trap 'rm -rf /tmp/example' EXIT",
      "for a in '-C5a25KeRr' '--' '--json' '--bogus'; do HOME=$(mktemp -d) MDE_URL=http://127.0.0.1:1 MDE_TOKEN=x node cli/mde.cjs ls \"$a\" >/tmp/mde-review-out 2>/tmp/mde-review-err; code=$?; printf '%s\\t%s\\t%s\\n' \"$a\" \"$code\" \"$(tr '\\n' ' ' </tmp/mde-review-err)\"; rm -rf \"$HOME\"; done",
    ]) {
      expect(detector.detect(command), command).toBe("forced-rm");
    }
  });

  it("does not match non-forced, quoted, dynamic, or invalid commands", () => {
    for (const command of [
      "rm -r /tmp/example",
      "rm -- -f",
      "echo 'rm -rf /tmp/example'",
      "cmd=rm; $cmd -rf /tmp/example",
      "if then rm -rf /tmp/example",
      "env TARGET=/tmp/example rm -r /tmp/example",
      "trap 'echo rm -rf /tmp/example' EXIT",
    ]) {
      expect(detector.detect(command), command).toBeUndefined();
    }
  });

  it("stops following literal wrappers after Codex's depth limit", () => {
    const eight = `${"sudo ".repeat(7)}rm -f /tmp/example`;
    const ten = `${"sudo ".repeat(10)}rm -f /tmp/example`;
    expect(detector.detect(eight)).toBe("forced-rm");
    expect(detector.detect(ten)).toBeUndefined();
  });

  it("rejects use after close", async () => {
    const closed = await createDangerousCommandDetector();
    closed.close();
    expect(() => closed.detect("echo ok")).toThrow(/closed/);
  });
});
