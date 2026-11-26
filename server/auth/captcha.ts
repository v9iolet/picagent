import { createHash, randomInt } from "node:crypto";

const alphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

export function generateCaptchaCode(): string {
  return Array.from({ length: 4 }, () => alphabet[randomInt(alphabet.length)]).join("");
}

export function hashCaptchaCode(captchaId: string, code: string): string {
  return createHash("sha256").update(`${captchaId}:${code.trim().toUpperCase()}`).digest("hex");
}

// Draw the glyphs directly so the SVG does not include the answer as selectable text.
// Each glyph occupies a 14 by 22 unit box.
const glyphs: Record<string, string> = {
  "2": "M1 5 Q2 0 7 0 Q14 0 13 6 Q13 10 8 14 L1 21 H14",
  "3": "M1 2 Q14 -3 13 5 Q13 10 6 10 Q14 10 14 16 Q14 24 1 20",
  "4": "M11 22 V0 L0 15 H15",
  "5": "M13 0 H2 L1 10 Q15 6 14 15 Q14 24 1 20",
  "6": "M12 1 Q0 -2 1 15 Q1 23 8 22 Q15 22 14 15 Q13 6 2 12",
  "7": "M0 0 H14 L4 22",
  "8": "M7 10 C-1 9 -1 0 7 0 C16 0 16 9 7 10 C-2 12 -2 22 7 22 C17 22 16 12 7 10",
  "9": "M2 21 Q13 25 13 8 Q13 0 7 0 Q0 0 0 7 Q0 15 12 11",
  A: "M0 22 L7 0 L14 22 M3 14 H11",
  B: "M1 22 V0 H7 Q15 0 13 6 Q12 10 6 10 H1 M7 10 Q15 10 14 16 Q14 22 7 22 H1",
  C: "M13 2 Q0 -5 0 11 Q0 27 13 20",
  D: "M1 22 V0 H5 Q15 0 14 11 Q14 22 5 22 Z",
  E: "M13 0 H1 V22 H14 M1 10 H11",
  F: "M13 0 H1 V22 M1 10 H11",
  G: "M13 2 Q0 -5 0 11 Q0 26 13 20 V12 H8",
  H: "M1 0 V22 M13 0 V22 M1 11 H13",
  J: "M5 0 H13 V16 Q13 27 1 20",
  K: "M1 0 V22 M13 0 L1 12 L14 22",
  L: "M1 0 V22 H14",
  M: "M0 22 V0 L7 12 L14 0 V22",
  N: "M1 22 V0 L13 22 V0",
  P: "M1 22 V0 H7 Q15 0 14 7 Q14 13 7 13 H1",
  Q: "M7 0 Q0 0 0 11 Q0 22 7 22 Q14 22 14 11 Q14 0 7 0 Z M8 16 L16 24",
  R: "M1 22 V0 H7 Q15 0 14 7 Q14 12 7 12 H1 M7 12 L14 22",
  S: "M13 2 Q1 -4 1 5 Q0 9 7 11 Q15 13 13 18 Q11 25 0 20",
  T: "M0 0 H14 M7 0 V22",
  U: "M1 0 V15 Q1 22 7 22 Q13 22 13 15 V0",
  V: "M0 0 L7 22 L14 0",
  W: "M0 0 L3 22 L7 11 L11 22 L14 0",
  X: "M0 0 L14 22 M14 0 L0 22",
  Y: "M0 0 L7 11 L14 0 M7 11 V22",
  Z: "M0 0 H14 L0 22 H14",
};

export function renderCaptchaSvg(code: string): string {
  if (code.length !== 4 || [...code].some((char) => !alphabet.includes(char))) {
    throw new Error("Expected four captcha characters");
  }
  const curves = Array.from({ length: 3 }, () =>
    `<path d="M0 ${randomInt(44)} C35 ${randomInt(44)} 92 ${randomInt(44)} 128 ${randomInt(44)}"/>`,
  ).join("");
  const dots = Array.from({ length: 38 }, () =>
    `<circle cx="${randomInt(128)}" cy="${randomInt(44)}" r="0.8"/>`,
  ).join("");
  const letters = [...code].map((char, index) => {
    const x = 13 + index * 29 + randomInt(-2, 3);
    const y = 11 + randomInt(-2, 3);
    const angle = randomInt(-9, 10);
    const ink = randomInt(2) ? "#232536" : "#312E81";
    return `<path transform="translate(${x} ${y}) rotate(${angle} 7 11)" stroke="${ink}" d="${glyphs[char]}"/>`;
  }).join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="44" viewBox="0 0 128 44">
    <rect width="128" height="44" fill="#F4F4F5"/><g stroke="#C2C3D0" fill="none">${curves}</g>
    <g fill="#B8B9C8">${dots}</g><g fill="none" stroke-width="2.9" stroke-linecap="round" stroke-linejoin="round">${letters}</g></svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}
