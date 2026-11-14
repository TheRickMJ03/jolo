import { schema, type Tool } from "./types.ts";

// Arithmetic only. The whitelist is the security boundary: with no letters
// accepted, the expression cannot name a variable, property or function, so
// there is nothing for it to reach.
const SAFE_EXPRESSION = /^[0-9+\-*/(). %]+$/;

export const mathTools: Tool[] = [
  {
    name: "calculate",
    description: "Evaluate an arithmetic expression. Supports + - * / % and parentheses.",
    parameters: schema(
      {
        expression: {
          type: "string",
          description: 'Arithmetic only, e.g. "(1200 * 1.08) / 12".',
        },
      },
      ["expression"],
    ),
    run(args) {
      const expression = String(args.expression ?? "").trim();
      if (!SAFE_EXPRESSION.test(expression)) {
        return "Refused: only numbers and + - * / % ( ) are allowed.";
      }
      try {
        const result = Function(`"use strict"; return (${expression});`)() as unknown;
        return typeof result === "number" && Number.isFinite(result)
          ? String(result)
          : "That did not evaluate to a finite number.";
      } catch {
        return "That is not a valid expression.";
      }
    },
  },
];
