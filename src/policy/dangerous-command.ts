/**
 * Derived from OpenAI Codex:
 * - codex-rs/shell-command/src/command_safety/is_dangerous_command.rs
 * - codex-rs/shell-command/src/bash.rs
 * revision 0fb559f0f6e231a88ac02ea002d3ecd248e2b515, Apache-2.0.
 *
 * Modified 2026 for Pi and the web-tree-sitter WASM API. The decision rule,
 * wrapper recursion limit, and literal-shell-word semantics are retained.
 */

import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { Language, type Node, Parser } from "web-tree-sitter";

export type DangerousCommandMatch = "forced-rm";

export interface DangerousCommandDetector {
  detect(command: string): DangerousCommandMatch | undefined;
  close(): void;
}

const MAX_WRAPPER_DEPTH = 8;

let runtimeInitialization: Promise<void> | undefined;
let bashLanguage: Promise<Language> | undefined;

function initializeRuntime(): Promise<void> {
  runtimeInitialization ??= Parser.init();
  return runtimeInitialization;
}

async function loadBashLanguage(): Promise<Language> {
  bashLanguage ??= (async () => {
    await initializeRuntime();
    const grammarUrl = import.meta.resolve("tree-sitter-bash/tree-sitter-bash.wasm");
    return Language.load(fileURLToPath(grammarUrl));
  })();
  return bashLanguage;
}

/**
 * Loads the pinned Bash grammar once, then returns a session-local parser.
 * Initialization failure is intentionally observable so callers can route the
 * command to Auto review instead of silently skipping the Codex rule.
 */
export async function createDangerousCommandDetector(): Promise<DangerousCommandDetector> {
  const language = await loadBashLanguage();
  const parser = new Parser();
  parser.setLanguage(language);
  let closed = false;

  return {
    detect(command: string): DangerousCommandMatch | undefined {
      if (closed) {
        throw new Error("dangerous-command detector is closed");
      }
      return dangerousCommandMatch(["bash", "-lc", command], 0, parser);
    },
    close(): void {
      if (!closed) {
        closed = true;
        parser.delete();
      }
    },
  };
}

function dangerousCommandMatch(
  command: readonly string[],
  wrapperDepth: number,
  parser: Parser,
): DangerousCommandMatch | undefined {
  if (wrapperDepth > MAX_WRAPPER_DEPTH) {
    return undefined;
  }

  const direct = dangerousMatchForExec(command, wrapperDepth, parser);
  if (direct !== undefined) {
    return direct;
  }

  const literalCommands = parseShellLiteralCommands(command, parser);
  if (literalCommands !== undefined) {
    for (const literalCommand of literalCommands) {
      const nested = dangerousCommandMatch(literalCommand, wrapperDepth + 1, parser);
      if (nested !== undefined) {
        return nested;
      }
    }
  }

  return undefined;
}

function dangerousMatchForExec(
  command: readonly string[],
  wrapperDepth: number,
  parser: Parser,
): DangerousCommandMatch | undefined {
  const executable = executableName(command[0]);

  if (executable === "rm" && rmArgsIncludeForce(command.slice(1))) {
    return "forced-rm";
  }
  if (executable === "sudo") {
    return dangerousCommandMatch(command.slice(1), wrapperDepth + 1, parser);
  }
  if (executable === "env") {
    return dangerousMatchForEnv(command, wrapperDepth, parser);
  }
  if (executable === "trap") {
    return dangerousMatchForTrap(command, wrapperDepth, parser);
  }
  return undefined;
}

function executableName(raw: string | undefined): string | undefined {
  if (raw === undefined || raw.length === 0) {
    return undefined;
  }
  return basename(raw);
}

function dangerousMatchForEnv(
  command: readonly string[],
  wrapperDepth: number,
  parser: Parser,
): DangerousCommandMatch | undefined {
  let commandIndex = 1;
  while (commandIndex < command.length) {
    const argument = command[commandIndex];
    if (argument === "--") {
      commandIndex += 1;
      break;
    }
    if (
      argument === "-i" ||
      argument === "--ignore-environment" ||
      isEnvironmentAssignment(argument)
    ) {
      commandIndex += 1;
      continue;
    }
    break;
  }
  return dangerousCommandMatch(command.slice(commandIndex), wrapperDepth + 1, parser);
}

function isEnvironmentAssignment(argument: string | undefined): boolean {
  if (argument === undefined) {
    return false;
  }
  const equals = argument.indexOf("=");
  return equals > 0 && argument[0] !== "-";
}

function dangerousMatchForTrap(
  command: readonly string[],
  wrapperDepth: number,
  parser: Parser,
): DangerousCommandMatch | undefined {
  let actionIndex = 1;
  if (command[actionIndex] === "--") {
    actionIndex += 1;
  }
  const action = command[actionIndex];
  if (action === undefined || action.startsWith("-")) {
    return undefined;
  }
  return dangerousCommandMatch(["sh", "-c", action], wrapperDepth + 1, parser);
}

function rmArgsIncludeForce(args: readonly string[]): boolean {
  for (const argument of args) {
    if (argument === "--") {
      return false;
    }
    if (argument === "--force") {
      return true;
    }
    if (
      argument.startsWith("-") &&
      !argument.startsWith("--") &&
      argument.slice(1).includes("f")
    ) {
      return true;
    }
  }
  return false;
}

function parseShellLiteralCommands(
  command: readonly string[],
  parser: Parser,
): string[][] | undefined {
  const script = extractShellScript(command);
  if (script === undefined) {
    return undefined;
  }

  const tree = parser.parse(script);
  if (tree === null) {
    return undefined;
  }
  try {
    if (tree.rootNode.hasError) {
      return undefined;
    }
    const commands: string[][] = [];
    const stack: Node[] = [tree.rootNode];
    while (stack.length > 0) {
      const node = stack.pop();
      if (node === undefined) {
        break;
      }
      if (node.type === "command") {
        const parsed = parseLiteralCommand(node);
        if (parsed !== undefined) {
          commands.push(parsed);
        }
      }
      for (const child of node.namedChildren) {
        if (child !== null) {
          stack.push(child);
        }
      }
    }
    return commands;
  } finally {
    tree.delete();
  }
}

function extractShellScript(command: readonly string[]): string | undefined {
  if (command.length !== 3) {
    return undefined;
  }
  const executable = executableName(command[0]);
  if (
    (executable !== "bash" && executable !== "zsh" && executable !== "sh") ||
    (command[1] !== "-lc" && command[1] !== "-c")
  ) {
    return undefined;
  }
  return command[2];
}

function parseLiteralCommand(command: Node): string[] | undefined {
  const words: string[] = [];
  let foundCommandName = false;

  for (const child of command.namedChildren) {
    if (child === null) {
      continue;
    }
    if (child.type === "command_name") {
      const nameNode = child.namedChild(0);
      if (nameNode === null) {
        return undefined;
      }
      const name = parseLiteralShellWord(nameNode);
      if (name === undefined) {
        return undefined;
      }
      words.push(name);
      foundCommandName = true;
    } else if (foundCommandName) {
      const word = parseLiteralShellWord(child);
      if (word !== undefined) {
        words.push(word);
      }
    }
  }

  return foundCommandName ? words : undefined;
}

function parseLiteralShellWord(node: Node): string | undefined {
  if ((node.type === "word" || node.type === "number") && node.namedChildCount === 0) {
    return node.text;
  }
  if (node.type === "string") {
    if (node.namedChildren.some((child) => child !== null && child.type !== "string_content")) {
      return undefined;
    }
    return stripMatchingQuotes(node.text, '"');
  }
  if (node.type === "raw_string") {
    return stripMatchingQuotes(node.text, "'");
  }
  if (node.type === "concatenation") {
    let result = "";
    for (const child of node.namedChildren) {
      if (child === null) {
        continue;
      }
      const part = parseLiteralShellWord(child);
      if (part === undefined) {
        return undefined;
      }
      result += part;
    }
    return result.length > 0 ? result : undefined;
  }
  return undefined;
}

function stripMatchingQuotes(text: string, quote: string): string | undefined {
  return text.startsWith(quote) && text.endsWith(quote)
    ? text.slice(quote.length, -quote.length)
    : undefined;
}
