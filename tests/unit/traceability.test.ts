import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

interface Evidence {
  readonly file: string;
  readonly title: string;
}

/**
 * This is deliberately explicit rather than a corpus-wide `I#` search. Each
 * normative invariant has a named executable witness, so deleting or renaming
 * the claimed evidence breaks CI at the traceability boundary.
 */
const INVARIANT_EVIDENCE: Readonly<Record<string, readonly Evidence[]>> = Object.freeze({
  I1: [{ file: "tests/e2e/extension.e2e.test.ts", title: "applies the Off, Unrestricted, and Auto routing matrix" }],
  I2: [{ file: "tests/e2e/extension.e2e.test.ts", title: "starts first-run sessions effectively Unrestricted until model plus thinking are selected" }],
  I3: [{ file: "tests/e2e/extension.e2e.test.ts", title: "reload alone restores Unrestricted; every fresh reason and descendant depth starts Auto" }],
  I4: [
    { file: "tests/e2e/extension.e2e.test.ts", title: "observes global Off/on from already-running sibling sessions" },
    { file: "tests/integration/config-multiprocess.test.ts", title: "serializes independent Pi processes into complete monotonic commits" },
  ],
  I5: [{ file: "tests/e2e/extension.e2e.test.ts", title: "routes all built-in file tools by source identity and canonical path class" }],
  I6: [{ file: "tests/e2e/extension.e2e.test.ts", title: "reviews every shell command on unsupported ReviewOnly and executes only allowed actions" }],
  I7: [
    { file: "tests/e2e/extension.e2e.test.ts", title: "executes ordinary Auto bash exactly once and only in the sandbox" },
    { file: "tests/integration/sandbox-real.test.ts", title: "enforces workspace writes, protected state, descendant confinement, and no network" },
  ],
  I8: [{ file: "tests/e2e/extension.e2e.test.ts", title: "rereads global reviewer thinking and rejects an approval captured under the stale tuple" }],
  I9: [{ file: "tests/e2e/extension.e2e.test.ts", title: "approved escalation runs local once; denial runs zero times" }],
  I10: [{ file: "tests/e2e/extension.e2e.test.ts", title: "supported sandbox failure denies every Auto shell command without model or process" }],
  I11: [{ file: "tests/e2e/extension.e2e.test.ts", title: "has no action-dialog path in noninteractive print mode and safer calls can continue" }],
  I12: [
    { file: "tests/e2e/extension.e2e.test.ts", title: "statically denies direct writes to the extension control plane" },
    { file: "tests/e2e/extension.e2e.test.ts", title: "never dispatches model-authored slash-like text as a permission command" },
  ],
  I13: [{ file: "tests/unit/state-store.test.ts", title: "writes a private, parseable file and increments only committed mutations" }],
  I14: [{ file: "tests/integration/permission-engine.test.ts", title: "denies argument mutation, mode ABA, backend change, and session death" }],
  I15: [
    { file: "tests/unit/guardian.reviewer.test.ts", title: "applies one aggregate deadline and aborts a hanging reviewer" },
    { file: "tests/unit/guardian.reviewer.test.ts", title: "bounds active/queued reviews and fails closed on queue exhaustion" },
  ],
  I16: [{ file: "tests/integration/permission-engine.test.ts", title: "never admits a delayed static action after parallel denials interrupt its turn" }],
  I17: [{ file: "tests/unit/sandbox-controller.test.ts", title: "selects ReviewOnly on unsupported operating systems without touching SRT" }],
});

describe("normative invariant traceability", () => {
  it("maps every invariant I1 through I17 to named executable evidence", () => {
    expect(Object.keys(INVARIANT_EVIDENCE)).toEqual(
      Array.from({ length: 17 }, (_, index) => `I${String(index + 1)}`),
    );

    for (const [invariant, evidenceSet] of Object.entries(INVARIANT_EVIDENCE)) {
      expect(evidenceSet.length, `${invariant} has no evidence`).toBeGreaterThan(0);
      for (const evidence of evidenceSet) {
        const absolute = path.join(repositoryRoot, evidence.file);
        expect(existsSync(absolute), `${invariant} evidence file is missing: ${evidence.file}`).toBe(true);
        expect(
          readFileSync(absolute, "utf8"),
          `${invariant} named evidence is missing: ${evidence.file} :: ${evidence.title}`,
        ).toContain(evidence.title);
      }
    }
  });
});
