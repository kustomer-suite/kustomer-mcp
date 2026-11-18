import type { RedactionRule } from "./spec.js";

export type TextSource = "customer" | "bot" | "agent" | "conversation" | "knowledge" | "tool";

export interface UntrustedText {
  untrusted: true;
  source: TextSource;
  text: string;
}

export function makeRedactor(rules: RedactionRule[]): (text: string) => string {
  const compiled = rules.map((r) => ({ re: new RegExp(r.pattern, "g"), replacement: r.replacement }));
  return (text) => compiled.reduce((t, r) => t.replace(r.re, r.replacement), text);
}

export function untrusted(source: TextSource, text: string, redact: (t: string) => string): UntrustedText {
  return { untrusted: true, source, text: redact(text) };
}
