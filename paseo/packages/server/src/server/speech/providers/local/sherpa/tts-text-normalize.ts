/**
 * Spell out numbers for the Kokoro lexicon frontend. sherpa-onnx >= 2.0 has no
 * espeak-ng, and its lexicon frontend silently drops any word it does not list,
 * which includes every digit string ("review 3 files" is spoken "review files").
 */

const ONES = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
  "thirteen",
  "fourteen",
  "fifteen",
  "sixteen",
  "seventeen",
  "eighteen",
  "nineteen",
];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
const SCALES: Array<[number, string]> = [
  [1_000_000_000, "billion"],
  [1_000_000, "million"],
  [1_000, "thousand"],
];

function below1000(n: number): string {
  const parts: string[] = [];
  if (n >= 100) {
    parts.push(`${ONES[Math.floor(n / 100)]} hundred`);
    n %= 100;
  }
  if (n >= 20) {
    parts.push(n % 10 ? `${TENS[Math.floor(n / 10)]} ${ONES[n % 10]}` : TENS[Math.floor(n / 10)]!);
  } else if (n > 0 || parts.length === 0) {
    parts.push(ONES[n]!);
  }
  return parts.join(" ");
}

export function integerToWords(n: number): string {
  if (n === 0) return "zero";
  const parts: string[] = [];
  for (const [value, name] of SCALES) {
    if (n >= value) {
      parts.push(`${below1000(Math.floor(n / value))} ${name}`);
      n %= value;
    }
  }
  if (n > 0) parts.push(below1000(n));
  return parts.join(" ");
}

function digitsToWords(digits: string): string {
  return digits
    .split("")
    .map((d) => ONES[Number(d)])
    .join(" ");
}

function numberToWords(raw: string): string {
  const [intPart = "", fracPart] = raw.replace(/,/g, "").split(".");
  // Long digit strings (ids, phone numbers) read better digit by digit.
  const whole =
    intPart.length > 12 || (intPart.length > 1 && intPart.startsWith("0"))
      ? digitsToWords(intPart)
      : integerToWords(Number(intPart));
  return fracPart ? `${whole} point ${digitsToWords(fracPart)}` : whole;
}

export function normalizeTextForLexiconTts(text: string): string {
  return text
    .replace(/(\d)%/g, "$1 percent")
    .replace(/\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/g, (m) => ` ${numberToWords(m)} `)
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}
