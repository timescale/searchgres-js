import { type Filter, filterSchema, timestampSchema } from "../inputs.ts";

export const MAX_FILTER_SOURCE_BYTES = 1024 * 1024;
export const MAX_FILTER_DEPTH = 16;
export const MAX_FILTER_NODES = 50;

export type FilterExpressionErrorReason =
  | "syntax"
  | "arity"
  | "json"
  | "validation"
  | "source_too_large"
  | "too_deep"
  | "too_many_nodes";

export interface ParseFilterOptions {
  readonly sourceName?: string;
}

/** A local DSL failure with stable machine-readable and source coordinates. */
export class FilterExpressionError extends Error {
  readonly reason: FilterExpressionErrorReason;
  readonly detail: string;
  readonly sourceName: string;
  readonly offset: number;
  readonly line: number;
  readonly column: number;
  readonly sourceLine: string;

  constructor(options: {
    readonly reason: FilterExpressionErrorReason;
    readonly detail: string;
    readonly source: string;
    readonly sourceName: string;
    readonly offset: number;
    readonly cause?: unknown;
  }) {
    const location = sourceLocation(options.source, options.offset);
    const prefix = [...location.before]
      .map((point) => (point === "\t" ? "  " : " "))
      .join("");
    const message = `${options.sourceName}:${location.line}:${location.column}: ${options.detail}\n${location.sourceLine}\n${prefix}^`;
    super(
      message,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "FilterExpressionError";
    this.reason = options.reason;
    this.detail = options.detail;
    this.sourceName = options.sourceName;
    this.offset = options.offset;
    this.line = location.line;
    this.column = location.column;
    this.sourceLine = location.sourceLine;
  }
}

type Operator =
  | "and"
  | "or"
  | "not"
  | "tree"
  | "lquery"
  | "ltxtquery"
  | "meta"
  | "meta-predicate"
  | "temporal-within"
  | "temporal-overlaps"
  | "temporal-before"
  | "temporal-after"
  | "temporal-contains"
  | "regexp";

interface ExpressionNode {
  readonly operator: Operator;
  readonly offset: number;
  readonly children: readonly ExpressionNode[];
  readonly values: readonly unknown[];
}

const operators = new Set<string>([
  "and",
  "or",
  "not",
  "tree",
  "lquery",
  "ltxtquery",
  "meta",
  "meta-predicate",
  "temporal-within",
  "temporal-overlaps",
  "temporal-before",
  "temporal-after",
  "temporal-contains",
  "regexp",
]);

const textArities: Readonly<Record<string, number>> = {
  tree: 1,
  lquery: 1,
  ltxtquery: 1,
  "meta-predicate": 1,
  "temporal-within": 2,
  "temporal-overlaps": 2,
  "temporal-before": 1,
  "temporal-after": 1,
  "temporal-contains": 1,
  regexp: 1,
};

/** Parse and compile one filter expression to a core-compatible filter AST. */
export function parseFilter(
  input: string,
  options: ParseFilterOptions = {},
): Filter {
  const source = input.startsWith("\uFEFF") ? input.slice(1) : input;
  const sourceName = options.sourceName ?? "--filter";
  if (new TextEncoder().encode(source).byteLength > MAX_FILTER_SOURCE_BYTES) {
    throw new FilterExpressionError({
      reason: "source_too_large",
      detail: `filter source exceeds ${MAX_FILTER_SOURCE_BYTES} UTF-8 bytes`,
      source,
      sourceName,
      offset: 0,
    });
  }
  const parser = new Parser(source, sourceName);
  return compile(parser.parse(), source, sourceName);
}

class Parser {
  private offset = 0;
  private nodes = 0;
  private readonly source: string;
  private readonly sourceName: string;

  constructor(source: string, sourceName: string) {
    this.source = source;
    this.sourceName = sourceName;
  }

  parse(): ExpressionNode {
    this.skipSpacing();
    const expression = this.parseExpression(1);
    this.skipSpacing();
    if (!this.atEnd()) this.fail("syntax", "unexpected trailing input");
    return expression;
  }

  private parseExpression(depth: number): ExpressionNode {
    const start = this.offset;
    if (depth > MAX_FILTER_DEPTH) {
      this.fail(
        "too_deep",
        `filter nesting exceeds the maximum depth of ${MAX_FILTER_DEPTH}`,
        start,
      );
    }
    this.nodes += 1;
    if (this.nodes > MAX_FILTER_NODES) {
      this.fail(
        "too_many_nodes",
        `filter contains more than ${MAX_FILTER_NODES} expression nodes`,
        start,
      );
    }

    if (this.peek() !== "(") {
      this.fail("syntax", "expected `(` to begin an expression", start);
    }
    this.offset += 1;
    const operatorOffset = this.offset;
    const rawOperator = this.readOperator();
    if (!operators.has(rawOperator)) {
      const shown =
        rawOperator === ""
          ? "an operator"
          : `known operator, found \`${rawOperator}\``;
      this.fail("syntax", `expected ${shown}`, operatorOffset);
    }
    const operator = rawOperator as Operator;

    if (operator === "and" || operator === "or") {
      this.requireSpacing(`after \`${operator}\``);
      const children: ExpressionNode[] = [];
      while (this.peek() !== ")" && !this.atEnd()) {
        children.push(this.parseExpression(depth + 1));
        const separated = this.skipSpacing();
        this.failIfUnclosed(operator);
        if (this.peek() !== ")" && !separated) {
          this.fail("syntax", "expected spacing between expressions");
        }
      }
      this.failIfUnclosed(operator);
      if (children.length < 2) {
        this.fail(
          "arity",
          `\`${operator}\` requires at least two expressions`,
          start,
        );
      }
      this.expectClose(operator, start);
      return { operator, offset: start, children, values: [] };
    }

    if (operator === "not") {
      this.requireSpacing("after `not`");
      if (this.peek() === ")" || this.atEnd()) {
        this.fail("arity", "`not` requires exactly one expression", start);
      }
      const child = this.parseExpression(depth + 1);
      this.skipSpacing();
      this.failIfUnclosed(operator);
      if (this.peek() !== ")") {
        this.fail("arity", "`not` requires exactly one expression", start);
      }
      this.offset += 1;
      return { operator, offset: start, children: [child], values: [] };
    }

    if (operator === "meta") {
      this.requireSpacing("after `meta`");
      const value = this.parseJsonObject();
      this.skipSpacing();
      this.failIfUnclosed(operator);
      if (this.peek() !== ")") {
        this.fail("arity", "`meta` requires exactly one JSON object", start);
      }
      this.offset += 1;
      return { operator, offset: start, children: [], values: [value] };
    }

    const arity = textArities[operator];
    if (arity === undefined) {
      this.fail("syntax", `unsupported operator \`${operator}\``, start);
    }
    const values: string[] = [];
    for (let index = 0; index < arity; index += 1) {
      this.requireSpacing(`before argument ${index + 1} of \`${operator}\``);
      values.push(this.parseText());
    }
    this.skipSpacing();
    this.failIfUnclosed(operator);
    if (this.peek() !== ")") {
      this.fail(
        "arity",
        `\`${operator}\` requires exactly ${arity} ${arity === 1 ? "argument" : "arguments"}`,
        start,
      );
    }
    this.offset += 1;
    return { operator, offset: start, children: [], values };
  }

  private parseText(): string {
    const start = this.offset;
    if (this.peek() === '"') return this.parseJsonString();
    while (!this.atEnd() && !isAtomDelimiter(this.peek())) this.offset += 1;
    if (this.offset === start) {
      this.fail("syntax", "expected a bare atom or JSON string", start);
    }
    return this.source.slice(start, this.offset);
  }

  private parseJsonString(): string {
    const start = this.offset;
    this.offset += 1;
    let escaped = false;
    while (!this.atEnd()) {
      const character = this.peek();
      this.offset += 1;
      if (escaped) {
        escaped = false;
        continue;
      }
      if (character === "\\") {
        escaped = true;
        continue;
      }
      if (character === '"') {
        const raw = this.source.slice(start, this.offset);
        try {
          const value: unknown = JSON.parse(raw);
          if (typeof value !== "string") throw new Error("not a string");
          return value;
        } catch (cause) {
          this.fail("json", "invalid JSON string", start, cause);
        }
      }
    }
    this.fail("json", "unterminated JSON string", start);
  }

  private parseJsonObject(): Record<string, unknown> {
    const start = this.offset;
    if (this.peek() !== "{") {
      this.fail("json", "`meta` expects a JSON object", start);
    }
    const stack: string[] = ["}"];
    this.offset += 1;
    let inString = false;
    let escaped = false;
    while (!this.atEnd() && stack.length > 0) {
      const character = this.peek();
      this.offset += 1;
      if (inString) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') inString = false;
        continue;
      }
      if (character === '"') inString = true;
      else if (character === "{") stack.push("}");
      else if (character === "[") stack.push("]");
      else if (character === "}" || character === "]") {
        const expected = stack.pop();
        if (expected !== character) {
          this.fail(
            "json",
            `expected \`${expected ?? "JSON value"}\``,
            this.offset - 1,
          );
        }
      }
    }
    if (stack.length > 0) this.fail("json", "unterminated JSON object", start);

    const raw = this.source.slice(start, this.offset);
    try {
      const value: unknown = JSON.parse(raw);
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        this.fail("json", "`meta` expects a JSON object", start);
      }
      return value as Record<string, unknown>;
    } catch (cause) {
      if (cause instanceof FilterExpressionError) throw cause;
      this.fail("json", "invalid JSON object", start, cause);
    }
  }

  private readOperator(): string {
    const start = this.offset;
    while (!this.atEnd() && !isOperatorDelimiter(this.peek())) this.offset += 1;
    return this.source.slice(start, this.offset);
  }

  private requireSpacing(context: string): void {
    if (!this.skipSpacing()) this.fail("syntax", `expected spacing ${context}`);
  }

  private skipSpacing(): boolean {
    const start = this.offset;
    while (!this.atEnd()) {
      const character = this.peek();
      if (isWhitespace(character)) {
        this.offset += 1;
        continue;
      }
      if (character !== ";") break;
      this.offset += 1;
      while (!this.atEnd() && this.peek() !== "\r" && this.peek() !== "\n") {
        this.offset += 1;
      }
    }
    return this.offset > start;
  }

  /** Report a missing `)` at the end of input before any arity check. */
  private failIfUnclosed(operator: Operator): void {
    if (this.atEnd()) {
      this.fail("syntax", `expected \`)\` to close \`${operator}\``);
    }
  }

  private expectClose(operator: Operator, start: number): void {
    if (this.peek() !== ")") {
      this.fail("syntax", `unterminated \`${operator}\` expression`, start);
    }
    this.offset += 1;
  }

  private peek(): string {
    return this.source[this.offset] ?? "";
  }

  private atEnd(): boolean {
    return this.offset >= this.source.length;
  }

  private fail(
    reason: FilterExpressionErrorReason,
    detail: string,
    offset = this.offset,
    cause?: unknown,
  ): never {
    throw new FilterExpressionError({
      reason,
      detail,
      source: this.source,
      sourceName: this.sourceName,
      offset,
      ...(cause === undefined ? {} : { cause }),
    });
  }
}

function compile(
  expression: ExpressionNode,
  source: string,
  sourceName: string,
): Filter {
  const children = expression.children.map((child) =>
    compile(child, source, sourceName),
  );
  const [first, second] = expression.values;
  let candidate: unknown;
  switch (expression.operator) {
    case "and":
      candidate = { and: children };
      break;
    case "or":
      candidate = { or: children };
      break;
    case "not":
      candidate = { not: children[0] };
      break;
    case "tree":
    case "lquery":
    case "ltxtquery":
    case "regexp":
      candidate = { [expression.operator]: first };
      break;
    case "meta":
      candidate = { meta: first };
      break;
    case "meta-predicate":
      candidate = { metaPredicate: first };
      break;
    case "temporal-within":
      candidate = { temporalWithin: [first, second] };
      break;
    case "temporal-overlaps":
      candidate = { temporalOverlaps: [first, second] };
      break;
    case "temporal-before":
      candidate = { temporalBefore: first };
      break;
    case "temporal-after":
      candidate = { temporalAfter: first };
      break;
    case "temporal-contains":
      candidate = { temporalContains: first };
      break;
  }

  if (
    (expression.operator === "temporal-within" ||
      expression.operator === "temporal-overlaps") &&
    typeof first === "string" &&
    typeof second === "string" &&
    Date.parse(first) >= Date.parse(second)
  ) {
    throw new FilterExpressionError({
      reason: "validation",
      detail: "interval start must be before its end",
      source,
      sourceName,
      offset: expression.offset,
    });
  }

  validateLeaf(expression, first, second, source, sourceName);

  const parsed = filterSchema.safeParse(candidate);
  if (!parsed.success) {
    const detail =
      parsed.error.issues[0]?.message ?? "invalid filter expression";
    throw new FilterExpressionError({
      reason: "validation",
      detail,
      source,
      sourceName,
      offset: expression.offset,
      cause: parsed.error,
    });
  }
  return parsed.data;
}

function validateLeaf(
  expression: ExpressionNode,
  first: unknown,
  second: unknown,
  source: string,
  sourceName: string,
): void {
  const fail = (detail: string): never => {
    throw new FilterExpressionError({
      reason: "validation",
      detail,
      source,
      sourceName,
      offset: expression.offset,
    });
  };

  if (expression.operator === "tree" && typeof first === "string") {
    if (
      first !== "" &&
      !first.split(".").every((label) => /^[A-Za-z0-9_-]+$/.test(label))
    ) {
      fail(
        "expected dot-separated ltree labels matching [A-Za-z0-9_-]+ (or an empty string for the root)",
      );
    }
  }

  if (
    ["lquery", "ltxtquery", "meta-predicate", "regexp"].includes(
      expression.operator,
    ) &&
    first === ""
  ) {
    fail(`\`${expression.operator}\` requires nonempty text`);
  }

  if (
    expression.operator === "meta" &&
    typeof first === "object" &&
    first !== null &&
    Object.keys(first).length === 0
  ) {
    fail("meta filter must not be an empty object");
  }

  if (
    [
      "temporal-within",
      "temporal-overlaps",
      "temporal-before",
      "temporal-after",
      "temporal-contains",
    ].includes(expression.operator)
  ) {
    const values = second === undefined ? [first] : [first, second];
    if (values.some((value) => !timestampSchema.safeParse(value).success)) {
      fail(
        `\`${expression.operator}\` expects ISO 8601 timestamps with offsets`,
      );
    }
  }
}

function isWhitespace(character: string): boolean {
  return (
    character === " " ||
    character === "\t" ||
    character === "\r" ||
    character === "\n"
  );
}

function isOperatorDelimiter(character: string): boolean {
  return (
    character === "" ||
    isWhitespace(character) ||
    character === ";" ||
    character === ")"
  );
}

function isAtomDelimiter(character: string): boolean {
  return (
    character === "" ||
    isWhitespace(character) ||
    '(){}[],";'.includes(character)
  );
}

function sourceLocation(
  source: string,
  rawOffset: number,
): {
  readonly line: number;
  readonly column: number;
  readonly sourceLine: string;
  readonly before: string;
} {
  const offset = Math.max(0, Math.min(rawOffset, source.length));
  let line = 1;
  let lineStart = 0;
  let index = 0;
  while (index < offset) {
    const character = source[index];
    if (character === "\r") {
      if (source[index + 1] === "\n") index += 1;
      line += 1;
      lineStart = index + 1;
    } else if (character === "\n") {
      line += 1;
      lineStart = index + 1;
    }
    index += 1;
  }
  let lineEnd = lineStart;
  while (
    lineEnd < source.length &&
    source[lineEnd] !== "\r" &&
    source[lineEnd] !== "\n"
  ) {
    lineEnd += 1;
  }
  const rawBefore = source.slice(lineStart, offset);
  const points = [...source.slice(lineStart, lineEnd)];
  const pointOffset = [...rawBefore].length;
  const maximumExcerptPoints = 160;
  const excerptStart = Math.max(
    0,
    Math.min(pointOffset - 80, points.length - maximumExcerptPoints),
  );
  const excerptEnd = Math.min(
    points.length,
    excerptStart + maximumExcerptPoints,
  );
  const leading = excerptStart > 0 ? "…" : "";
  const trailing = excerptEnd < points.length ? "…" : "";
  return {
    line,
    column: pointOffset + 1,
    sourceLine: `${leading}${points.slice(excerptStart, excerptEnd).join("")}${trailing}`,
    before: `${leading}${points.slice(excerptStart, pointOffset).join("")}`,
  };
}
