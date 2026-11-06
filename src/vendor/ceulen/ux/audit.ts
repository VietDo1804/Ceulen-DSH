// ux module — deterministic slop-audit engine (no model, no deps).
// ponytail: vendored from @bacnh85/pi-ux 0.6.6 (hooks/ux-audit.js, CJS → ESM TS).
//
// Four gates, all computable:
//   1. Contrast  — APCA Lc (primary, perceptual) + WCAG 2.x ratio (sidecar).
//   2. Tokens    — off-system values (raw hex, magic px, ad-hoc shadows).
//   3. States    — interactive elements missing focus-visible / disabled.
//   4. SlopTells — named AI signatures (glassmorphism, orbs, glow, default-card).
//
// All gates are mechanical linting, not judgement. APCA math is ~25 lines;
// WCAG is ~10; token scan is regex; state scan is substring; tell scan is
// co-occurrence heuristics. No wcag-contrast lib, no css parser, no AST.

// --- colour parsing -------------------------------------------------------
// Accepts hex (3/4/6/8-digit) and oklch(L C H) / oklch(L C H / a). Returns
// [r,g,b] 0-255, or null. oklch support matters because DESIGN.md (Google's
// open standard) allows oklch() values.

export type Rgb = [number, number, number];

export function parseHex(hex: unknown): Rgb | null {
  const m = /^#?([0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{4}|[0-9a-f]{3})$/i.exec(String(hex).trim());
  if (!m || !m[1]) return null;
  let h = m[1];
  if (h.length === 8) h = h.slice(0, 6); // drop alpha
  if (h.length === 4) h = h.slice(0, 3);
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

// ponytail: standard oklch->linear-sRGB->sRGB. ~20 lines, no dep. Handles the
// cases DESIGN.md allows; guards NaN/overflow.
export function parseOklch(str: unknown): Rgb | null {
  const m = /^oklch\(\s*([0-9.]+%?)\s+([0-9.]+)\s+([0-9.]+)(?:deg)?\s*(?:\/\s*([0-9.]+))?%?\s*\)$/i.exec(String(str).trim());
  if (!m || !m[1] || !m[2] || !m[3]) return null;
  const L = Math.min(Math.max(parseFloat(m[1]) / (String(m[1]).endsWith("%") ? 100 : 1), 0), 1);
  const C = parseFloat(m[2]);
  const Hdeg = parseFloat(m[3]);
  if ([L, C, Hdeg].some(Number.isNaN)) return null;
  const h = (Hdeg * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);
  // OKLab -> linear sRGB
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l3 = l_ ** 3, m3 = m_ ** 3, s3 = s_ ** 3;
  let r = 4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3;
  let g = -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3;
  let bl = -0.0041960863 * l3 - 0.7034186147 * m3 + 1.707614701 * s3;
  // linear -> sRGB gamma encoding, then to 0-255. APCA's sRGBtoY expects
  // gamma-encoded sRGB (same as hex produces); without this, oklch values
  // double-linearize and contrast is wrong.
  const enc = (c: number) => {
    c = Math.min(Math.max(c, 0), 1);
    return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  };
  const to255 = (c: number) => Math.round(enc(c) * 255);
  return [to255(r), to255(g), to255(bl)];
}

// ponytail: standard hsl->rgb, ~15 lines, no dep. Alpha is dropped (contrast
// gates treat a colour as opaque, matching the hex parser's alpha stripping).
export function parseHsl(str: unknown): Rgb | null {
  const m = /^hsla?\(\s*([0-9.]+)(?:deg)?(?:\s*,\s*|\s+)([0-9.]+)%(?:\s*,\s*|\s+)([0-9.]+)%\s*(?:(?:,|\/)\s*([0-9.]+%?))?\s*\)$/i.exec(String(str).trim());
  if (!m || !m[1] || !m[2] || !m[3]) return null;
  const h = parseFloat(m[1]) / 360;
  const s = parseFloat(m[2]) / 100;
  const l = parseFloat(m[3]) / 100;
  if ([h, s, l].some(Number.isNaN)) return null;
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hue = (t: number) => {
    let x = t % 1;
    if (x < 0) x += 1;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  return [hue(h + 1 / 3), hue(h), hue(h - 1 / 3)].map((c) => Math.round(c * 255)) as Rgb;
}

export function parseRgb(str: unknown): Rgb | null {
  const m = /^rgba?\(\s*(\d{1,3})(?:\s*,\s*|\s+)(\d{1,3})(?:\s*,\s*|\s+)(\d{1,3})\s*(?:(?:,|\/)\s*([0-9.]+%?))?\s*\)$/i.exec(String(str).trim());
  if (!m || !m[1] || !m[2] || !m[3]) return null;
  const r = +m[1], g = +m[2], b = +m[3];
  if (r > 255 || g > 255 || b > 255) return null;
  return [r, g, b]; // alpha dropped, like 8-digit hex
}

export function parseColor(input: unknown): Rgb | null {
  const s = String(input).trim();
  const named = NAMED_COLORS[s.toLowerCase()];
  if (named !== undefined) return parseHex(named);
  if (s.startsWith("#") || /^[0-9a-f]{3,8}$/i.test(s)) return parseHex(s);
  const lower = s.toLowerCase();
  if (lower.startsWith("oklch")) return parseOklch(s);
  if (lower.startsWith("rgb")) return parseRgb(s);
  if (lower.startsWith("hsl")) return parseHsl(s);
  return parseHex(s); // falls back to hex parser (returns null on garbage)
}

// ponytail: the 16 CSS Level 1 colours + `transparent`. That covers
// `color: white; background: white` — the reported false PASS — without
// shipping the 148-entry CSS colour table. Unknown names stay unparseable
// (inconclusive), they are not guessed.
const NAMED_COLORS: Record<string, string> = {
  transparent: "#00000000",
  black: "#000000",
  silver: "#c0c0c0",
  gray: "#808080",
  grey: "#808080",
  white: "#ffffff",
  maroon: "#800000",
  red: "#ff0000",
  purple: "#800080",
  fuchsia: "#ff00ff",
  magenta: "#ff00ff",
  green: "#008000",
  lime: "#00ff00",
  olive: "#808000",
  yellow: "#ffff00",
  navy: "#000080",
  blue: "#0000ff",
  teal: "#008080",
  aqua: "#00ffff",
  cyan: "#00ffff",
  orange: "#ffa500",
};

/**
 * Alpha of a colour declaration, 1 when it carries none. Kept separate from
 * `parseColor` so the long-standing parsers keep returning plain `[r,g,b]`
 * (every caller and upstream test relies on that).
 */
export function parseAlpha(input: unknown): number {
  const s = String(input).trim().toLowerCase();
  if (s === "transparent") return 0;
  const hex = /^#?([0-9a-f]{4}|[0-9a-f]{8})$/.exec(s);
  if (hex && hex[1] !== undefined) {
    const h = hex[1];
    const tail = h.slice(h.length - (h.length === 4 ? 1 : 2));
    const value = parseInt(tail.length === 1 ? tail + tail : tail, 16);
    return Number.isNaN(value) ? 1 : value / 255;
  }
  const fn = /^(?:rgba|hsla|rgb|hsl|oklch)\(([^)]*)\)$/.exec(s);
  if (fn && fn[1] !== undefined) {
    const body = fn[1];
    const slash = body.split("/");
    if (slash.length === 2 && slash[1] !== undefined) return alphaValue(slash[1]);
    if (/^(?:rgba|hsla)\(/.test(s)) {
      const parts = body.split(",");
      if (parts.length === 4 && parts[3] !== undefined) return alphaValue(parts[3]);
    }
  }
  return 1;
}

function alphaValue(raw: string): number {
  const text = raw.trim().replace(/!important/i, "").trim();
  const value = text.endsWith("%") ? parseFloat(text) / 100 : parseFloat(text);
  if (!Number.isFinite(value)) return 1;
  return Math.min(Math.max(value, 0), 1);
}

// --- APCA contrast (primary gate) -----------------------------------------
// Canonical APCA 0.0.98G-4g (W3, constants fixed since Feb 2021). Source:
// Myndex/apca-w3 master src/apca-w3.js (fetched 2024). Returns signed Lc:
// positive = dark text on light bg (BoW); negative = light text on dark (WoB).
// Range ≈ ±106. Polarity matters — text is the FIRST arg, bg the SECOND.

const APCA = {
  mainTRC: 2.4, sRco: 0.2126729, sGco: 0.7151522, sBco: 0.072175,
  normBG: 0.56, normTXT: 0.57, revTXT: 0.62, revBG: 0.65,
  blkThrs: 0.022, blkClmp: 1.414, scaleBoW: 1.14, scaleWoB: 1.14,
  loBoWoffset: 0.027, loWoBoffset: 0.027, deltaYmin: 0.0005, loClip: 0.1,
};

export function sRGBtoY(rgb: readonly number[]): number {
  const [r, g, b] = rgb;
  const exp = (chan: number) => Math.pow(chan / 255.0, APCA.mainTRC);
  return APCA.sRco * exp(r!) + APCA.sGco * exp(g!) + APCA.sBco * exp(b!);
}

export function apcaContrastLc(textColor: unknown, bgColor: unknown): number | null {
  const txtRgb = parseColor(textColor);
  const bgRgb = parseColor(bgColor);
  if (!txtRgb || !bgRgb) return null;
  let txtY = sRGBtoY(txtRgb);
  let bgY = sRGBtoY(bgRgb);
  if (isNaN(txtY) || isNaN(bgY) || Math.min(txtY, bgY) < 0 || Math.max(txtY, bgY) > 1.1) return 0.0;
  // soft black clamp
  txtY = txtY > APCA.blkThrs ? txtY : txtY + Math.pow(APCA.blkThrs - txtY, APCA.blkClmp);
  bgY = bgY > APCA.blkThrs ? bgY : bgY + Math.pow(APCA.blkThrs - bgY, APCA.blkClmp);
  if (Math.abs(bgY - txtY) < APCA.deltaYmin) return 0.0;
  let SAPC: number, out: number;
  if (bgY > txtY) { // BoW: dark text on light
    SAPC = (Math.pow(bgY, APCA.normBG) - Math.pow(txtY, APCA.normTXT)) * APCA.scaleBoW;
    out = SAPC < APCA.loClip ? 0.0 : SAPC - APCA.loBoWoffset;
  } else { // WoB: light text on dark — negative
    SAPC = (Math.pow(bgY, APCA.revBG) - Math.pow(txtY, APCA.revTXT)) * APCA.scaleWoB;
    out = SAPC > -APCA.loClip ? 0.0 : SAPC + APCA.loWoBoffset;
  }
  return out * 100.0;
}

// APCA threshold for a text/bg pair by font weight + size (px).
// Spec guidance: Lc 75 body, 60 for 400@18px+, 45 large/bold, 30 non-text.
// Non-text pairs (min: 3 = WCAG "large/UI" floor, no size/weight given) are
// graphics, not copy — they gate at Lc 30 per the gate table.
export function apcaThreshold(weight?: unknown, size?: unknown, isNonText = false, role?: unknown): number {
  if (isNonText) return 30;
  const w = numericWeight(weight) ?? 400;
  const px = pixelSize(size);
  const s = px ?? 16;
  const bold = w >= 700;
  // APCA font-Lc lookup: Lc 45 = ≥24px regular or ≥18px bold; Lc 60 = ≥18px
  // regular or bold body (14–17px); Lc 75 = small body. Bold body text is
  // NOT exempt from readability — it stays at Lc 60 until it's also large.
  if (s >= 24 || (bold && s >= 18)) return 45;
  if (s >= 18 || bold) return 60;
  // Secondary copy (captions, metadata, helper text) is read, not studied: APCA
  // puts it at Lc 60. Holding it to 75 pushed muted text up to the primary and
  // flattened the hierarchy. It must state a size, and tiny type keeps 75.
  if (role === "secondary" && px !== undefined && px >= SECONDARY_MIN_PX) return 60;
  return 75; // body text — strictest
}

/** Below this, secondary text keeps the body threshold. */
export const SECONDARY_MIN_PX = 12;

/** The tool schema types these as strings, so "700" must mean 700, not "unset". */
export function numericWeight(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string") return undefined;
  const text = value.trim().toLowerCase();
  if (text === "bold") return 700;
  if (text === "normal") return 400;
  const parsed = Number(text);
  return text !== "" && Number.isFinite(parsed) ? parsed : undefined;
}

/** "14px", "14", 14, "0.875rem", and "0.875em" (at the 16px root) all give px. */
export function pixelSize(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string") return undefined;
  const match = /^\s*([0-9]*\.?[0-9]+)\s*(px|rem|em)?\s*$/i.exec(value);
  if (match === null) return undefined;
  const amount = Number(match[1]);
  return (match[2] ?? "px").toLowerCase() === "px" ? amount : amount * 16;
}

// --- WCAG 2.x contrast (compliance sidecar) -------------------------------
// Kept verbatim from v0.3.0 — some orgs must report the WCAG ratio. APCA is
// the primary gate; WCAG is shown alongside for procurement/legal.

export function channelLuminance(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

export function relativeLuminance(hex: unknown): number | null {
  const rgb = parseColor(hex);
  if (!rgb) return null;
  return 0.2126 * channelLuminance(rgb[0]) + 0.7152 * channelLuminance(rgb[1]) + 0.0722 * channelLuminance(rgb[2]);
}

export function contrastRatio(fg: unknown, bg: unknown): number | null {
  const l1 = relativeLuminance(fg);
  const l2 = relativeLuminance(bg);
  if (l1 === null || l2 === null) return null;
  const light = Math.max(l1, l2);
  const dark = Math.min(l1, l2);
  return (light + 0.05) / (dark + 0.05);
}

// --- token coverage -------------------------------------------------------

// ponytail: a real CSS parser is overkill. Token *definitions* are read from
// every scope that declares custom properties in practice — :root, `.dark`,
// [data-theme], :host, and Tailwind v4's @theme — so a value declared there is
// recognised as part of the system instead of a hardcoded violation. A flat
// `prelude { decls }` regex is enough: at-rule wrappers (media/layer/support)
// cannot match it because their bodies contain braces.

const RULE_RE = /([^{}]+)\{([^{}]*)\}/g;
const TOKEN_SCOPE_RE = /^(?::root\b|:host\b|\.dark\b|@theme\b|\[data-theme|html\[data-theme|html\.dark\b)/i;

export interface CssRule {
  selector: string;
  decls: string;
}

/** Visit every flat rule; at-rule preludes (media/support/keyframes) are skipped. */
function eachRule(css: string, visit: (rule: CssRule) => void): void {
  RULE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = RULE_RE.exec(css)) !== null) {
    const selector = (match[1] ?? "").trim();
    if (selector === "" || selector.startsWith("@media") || selector.startsWith("@supports") || selector.startsWith("@layer") || selector.startsWith("@keyframes")) continue;
    visit({ selector, decls: match[2] ?? "" });
  }
}

/**
 * Comments must go first: RULE_RE takes everything before `{` as the selector,
 * so the header comment most stylesheets open with hid `:root` from the token
 * scan and every var() pair came back unresolved.
 */
function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, " ");
}

function isTokenScope(selector: string): boolean {
  const first = selector.split(",")[0]?.trim() ?? "";
  return TOKEN_SCOPE_RE.test(first);
}

function collectTokenValues(css: string): Map<string, string> {
  const values = new Map<string, string>(); // --name -> value
  eachRule(css, ({ selector, decls }) => {
    if (!isTokenScope(selector)) return;
    const declRe = /--([a-zA-Z0-9-]+)\s*:\s*([^;]+)(?:;|$)/g;
    let decl: RegExpExecArray | null;
    while ((decl = declRe.exec(decls)) !== null) {
      values.set("--" + decl[1]!.trim(), decl[2]!.trim());
    }
  });
  return values;
}

/** Removes token-definition blocks so their values are not reported as violations. */
function stripTokenBlocks(css: string): string {
  RULE_RE.lastIndex = 0;
  return css.replace(RULE_RE, (whole, selector: string) => (isTokenScope(selector) ? " " : whole));
}

export function extractTokens(css: string): Map<string, string> {
  const tokens = new Map<string, string>(); // value -> name(s)
  eachRule(stripCssComments(css), ({ selector, decls }) => {
    if (!isTokenScope(selector)) return;
    const declRe = /--([a-zA-Z0-9-]+)\s*:\s*([^;]+)(?:;|$)/g;
    let decl: RegExpExecArray | null;
    while ((decl = declRe.exec(decls)) !== null) {
      const name = decl[1]!.trim();
      const value = decl[2]!.trim();
      const key = value.toLowerCase().replace(/\s+/g, " ");
      const existing = tokens.get(key);
      tokens.set(key, existing ? `${existing},--${name}` : `--${name}`);
    }
  });
  return tokens;
}

// ponytail: negative lookahead (?![0-9a-f]) instead of \b — \b fails between
// adjacent hex digits so 8-digit alpha hex (#RRGGBBAA) was invisible to this
// gate. Now matches 3/4/6/8-digit hex without partial-matching longer values.
const RAW_HEX_RE = /#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})(?![0-9a-f])/gi;
const BOX_SHADOW_RE = /box-shadow\s*:\s*([^;}]+)/gi;

export interface OffSystemFindings {
  hardcodedHex: string[];
  adhocShadow: string[];
  /** Selector for every hardcoded value, so a fix can say WHERE to change it. */
  hexUses: Array<{ selector: string; value: string }>;
}

export function scanOffSystem(css: string, tokens: Map<string, string>): OffSystemFindings {
  const findings: OffSystemFindings = { hardcodedHex: [], adhocShadow: [], hexUses: [] };

  // Comments must not fail the gate (same stripper as scanStates/scanSlopTells):
  // a commented-out `/* color: #ff0000 */` is dead code, not a violation.
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, " ");
  const rootFree = stripTokenBlocks(stripped);
  eachRule(rootFree, ({ selector, decls }) => {
    RAW_HEX_RE.lastIndex = 0;
    let hexMatch: RegExpExecArray | null;
    while ((hexMatch = RAW_HEX_RE.exec(decls)) !== null) {
      const hex = hexMatch[0];
      if (tokens.has(hex.toLowerCase())) continue;
      findings.hardcodedHex.push(hex);
      findings.hexUses.push({ selector: selector.replace(/\s+/g, " ").slice(0, 60), value: hex });
    }
    BOX_SHADOW_RE.lastIndex = 0;
    let shadowMatch: RegExpExecArray | null;
    while ((shadowMatch = BOX_SHADOW_RE.exec(decls)) !== null) {
      const val = shadowMatch[1] ?? "";
      if (!/var\(--/.test(val)) findings.adhocShadow.push(val.trim());
    }
  });

  return findings;
}

// --- state coverage -------------------------------------------------------

export interface StateFindings {
  missingFocusVisible: string[];
  missingDisabled: string[];
  missingReducedMotion: string[];
  /** `:focus`/`:focus-visible` blocks that hide the ring without a replacement. */
  focusRingKills: string[];
  hasInteractive: boolean;
  /** Any animation/transition/smooth-scroll declaration was found. */
  hasMotion: boolean;
}

// State coverage is checked PER INTERACTIVE BASE, not per file (the reported
// false PASS: one `.btn:focus-visible` excused every other component).
// ponytail: no CSS parser. A base selector is the selector with pseudo-classes
// stripped; "interactive" is an element control, [role=button], or a rule that
// declares `cursor: pointer`. Without the DOM, anything less explicit is a
// guess — the runtime mode checks actual focusability.

const STATE_PSEUDO_RE = /::?[a-zA-Z-]+(?:\([^)]*\))?/g;
const INTERACTIVE_ELEMENT_RE = /(?:^|[\s>+~])(?:button|a|input|select|textarea|summary)(?=$|[\s>+~.:#[\]])/i;
const ROLE_BUTTON_RE = /\[role\s*=\s*"?button"?\]/i;
const MOTION_DECL_RE = /(?:^|;)\s*(?:transition(?:-(?:property|duration|delay|timing-function))?|animation(?:-(?:name|duration|delay|timing-function|iteration-count|direction|fill-mode|play-state))?|scroll-behavior)\s*:/i;
const REDUCED_DECL_RE = /(?:^|;)\s*(?:animation|transition)(?:-(?:duration|play-state))?\s*:\s*(?:none|0(?:\.0+)?(?:m?s)|0\.01m?s)\b/i;

function baseSelector(part: string): string {
  return part
    .replace(STATE_PSEUDO_RE, "")
    // State attributes describe the state, not a different base: `a[aria-disabled]`
    // covers the `a` base exactly like `a:disabled` does.
    .replace(/\[aria-[a-z-]+(?:=(?:"[^"]*"|'[^']*'|[^\]]*))?\]/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** The element token a base starts with (`button` in `button.btn`), if any. */
function elementOf(base: string): string | null {
  const match = /^([a-z][a-z0-9-]*)/i.exec(base);
  return match?.[1]?.toLowerCase() ?? null;
}

/** A state rule on the bare element covers every compound of that element. */
function coveredBy(base: string, covered: Set<string>): boolean {
  if (covered.has(base)) return true;
  const element = elementOf(base);
  if (element !== null && element !== base && covered.has(element)) return true;
  // A class-only component (`.btn`, `.tab`) is applied to some element that
  // the HTML declares, which is invisible in the stylesheet. If the file
  // covers the element controls at all, credit the class with that coverage —
  // otherwise every class-based design system would fail on a rule we cannot
  // statically decide. When NO element base is covered (the reported
  // `.card-action` case), the class stays a finding.
  if (base.startsWith(".") || base.startsWith("[")) {
    for (const control of ["a", "button", "input", "select", "textarea"]) if (covered.has(control)) return true;
  }
  return false;
}

/** Body of every `@media (prefers-reduced-motion: reduce)` block, brace-matched. */
function reducedMotionBodies(css: string): string[] {
  const bodies: string[] = [];
  const marker = /prefers-reduced-motion\s*:\s*reduce/gi;
  let match: RegExpExecArray | null;
  while ((match = marker.exec(css)) !== null) {
    const open = css.indexOf("{", match.index);
    if (open < 0) continue;
    let depth = 0;
    for (let i = open; i < css.length; i++) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}") {
        depth--;
        if (depth === 0) {
          bodies.push(css.slice(open + 1, i));
          break;
        }
      }
    }
  }
  return bodies;
}

function reducedMotionCoverage(css: string): { bases: Set<string>; blanket: boolean } {
  const bases = new Set<string>();
  let blanket = false;
  for (const body of reducedMotionBodies(css)) {
    eachRule(body, ({ selector, decls }) => {
      if (!REDUCED_DECL_RE.test(decls)) return;
      for (const part of selector.split(",")) {
        const base = baseSelector(part);
        if (base === "" || base === "*" || base === "html" || base === "body" || base === ":root") blanket = true;
        else bases.add(base);
      }
    });
  }
  return { bases, blanket };
}

export function scanStates(css: string): StateFindings {
  let stripped = css.replace(/\/\*[\s\S]*?\*\//g, " "); // dead code must not fail the gate
  stripped = stripped.replace(/"[^"]*"|'[^']*'/g, " "); // quoted words ("a b" in grid-template-areas) are not selectors
  stripped = stripTokenBlocks(stripped); // token definitions are not component rules
  const varFree = stripped.replace(/var\(--[a-zA-Z0-9-]+(?:\s*,[^)]*)?\)/g, " "); // --input-bg is not an <input>

  const findings: StateFindings = { missingFocusVisible: [], missingDisabled: [], missingReducedMotion: [], focusRingKills: [], hasInteractive: false, hasMotion: false };
  const interactive = new Set<string>();
  const focusCovered = new Set<string>();
  const disabledCovered = new Set<string>();
  let globalFocus = false;
  let globalDisabled = false;
  const motionBases = new Set<string>();

  eachRule(varFree, ({ selector, decls }) => {
    const isFocusRule = /:focus(?:-visible)?\b/.test(selector);
    const isDisabledRule = /:disabled\b|\[aria-disabled/i.test(selector);
    const pointer = /(?:^|;)\s*cursor\s*:\s*pointer\b/i.test(decls);
    if (MOTION_DECL_RE.test(decls)) {
      for (const part of selector.split(",")) {
        const base = baseSelector(part);
        if (base !== "") motionBases.add(base);
      }
    }
    for (const part of selector.split(",")) {
      const base = baseSelector(part);
      if (base === "" || base === "*") {
        if (isFocusRule) globalFocus = true;
        if (isDisabledRule) globalDisabled = true;
        continue;
      }
      if (INTERACTIVE_ELEMENT_RE.test(base) || ROLE_BUTTON_RE.test(base) || pointer) interactive.add(base);
      if (isFocusRule) focusCovered.add(base);
      if (isDisabledRule) disabledCovered.add(base);
    }
  });

  // Focus-ring kill: `outline: none` on a focus rule with no visible replacement.
  eachRule(varFree, ({ selector, decls }) => {
    if (!/:focus(?:-visible)?\b/.test(selector)) return;
    const valueOf = (name: string): string | null => {
      const match = new RegExp(`(?:^|;)\\s*${name}\\s*:\\s*([^;]+)`, "i").exec(decls);
      return match?.[1]?.trim() ?? null;
    };
    const outline = valueOf("outline");
    const first = outline === null ? "" : (outline.split(/\s+/)[0] ?? "").toLowerCase();
    const killed = (outline !== null && (first === "none" || first === "0" || first === "0px")) || (valueOf("outline-style") ?? "") === "none" || /^0(?:px)?$/.test((valueOf("outline-width") ?? "").toLowerCase());
    if (!killed) return;
    const outlineReplaced = outline !== null && first !== "none" && first !== "0" && first !== "0px";
    const shadow = (valueOf("box-shadow") ?? "").toLowerCase();
    const border = (valueOf("border") ?? "").toLowerCase();
    const replaced = outlineReplaced || (shadow !== "" && shadow !== "none") || (border !== "" && border !== "none" && !/^0(?:px)?$/.test(border));
    if (!replaced) findings.focusRingKills.push(selector.trim().slice(0, 60));
  });

  findings.hasInteractive = interactive.size > 0;
  findings.hasMotion = motionBases.size > 0;
  if (!findings.hasInteractive && motionBases.size === 0) return findings;

  if (findings.hasInteractive && !globalFocus) {
    for (const base of interactive) if (!coveredBy(base, focusCovered)) findings.missingFocusVisible.push(base);
  }
  if (findings.hasInteractive && !globalDisabled) {
    for (const base of interactive) if (!coveredBy(base, disabledCovered)) findings.missingDisabled.push(base);
  }

  if (motionBases.size > 0) {
    const coverage = reducedMotionCoverage(stripped);
    if (!coverage.blanket) {
      for (const base of motionBases) {
        if (!coverage.bases.has(base)) findings.missingReducedMotion.push(`${base}: motion without a prefers-reduced-motion fallback`);
      }
    }
  }

  return findings;
}

// --- slop tells (named AI signatures) -------------------------------------
// Co-occurrence heuristics, not single-keyword flags, to avoid false positives
// on legitimate token-based elevation. Each tell is documented with the slop it
// catches and the conservative pattern that must all match.

const PX_PER_UNIT: Record<string, number> = { px: 1, rem: 16, em: 16, pt: 16 / 12 };

export function scanSlopTells(css: string): { tells: string[] } {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, " "); // dead code must not fail the gate
  const tells: string[] = [];
  const lower = stripped.toLowerCase();

  // 1. Glassmorphism — backdrop-filter anywhere is the tell.
  if (lower.includes("backdrop-filter")) {
    tells.push("glassmorphism (backdrop-filter) — faux depth implying capability the feature lacks");
  }

  // 2. Gradient orbs — radial-gradient with a violet/purple/indigo hue +
  //    large blur. The orb signature is a big diffuse coloured blob: check
  //    for a blue-dominant saturated hex (B > R+20 AND B > G+20) and a large
  //    blur (filter:blur(NNpx) in the CSS or ≥100px size in the gradient).
  //    ponytail: allow one level of nested parens (rgba/hsl stops) so the
  //    full gradient value is captured, not truncated at the first inner ).
  const hasBigFilterBlur = /blur\(\s*\d{2,}\s*px/i.test(stripped);
  const radial = /radial-gradient\(([^()]*(?:\([^()]*\)[^()]*)*)\)/gi;
  radial.lastIndex = 0;
  let rm: RegExpExecArray | null;
  while ((rm = radial.exec(stripped)) !== null) {
    const v = rm[0];
    const hasVioletHue = [...v.matchAll(/#(?:[0-9a-f]{3}|[0-9a-f]{6})\b/gi)].some((hm) => {
      const rgb = parseHex(hm[0]);
      if (!rgb) return false;
      return rgb[2] > rgb[0] + 20 && rgb[2] > rgb[1] + 20; // B-dominant
    });
    const bigBlur = hasBigFilterBlur || /\b\d{3,}px\b/.test(v);
    if (hasVioletHue && bigBlur) {
      tells.push("gradient orb (violet/purple radial-gradient with large blur) — the #1 AI-slop signature");
      break;
    }
  }

  // 3. Neon glow — coloured box-shadow with large blur (≥20px). Checks BOTH
  //    rgba() and hex colours. A normal accent shadow (≤12px blur) is NOT a
  //    glow; a large coloured blur is the v0/Cursor tell.
  const shadowRe = /box-shadow\s*:\s*([^;}]+)/gi;
  shadowRe.lastIndex = 0;
  let sm: RegExpExecArray | null;
  while ((sm = shadowRe.exec(stripped)) !== null) {
    const v = sm[1] ?? "";
    const pxVals = [...v.matchAll(/(\d+(?:\.\d+)?)px/gi)].map((mm) => parseFloat(mm[1]!));
    const maxPx = pxVals.length ? Math.max(...pxVals) : 0;
    if (maxPx < 20) continue; // small blur = normal shadow, not glow

    const colours: number[][] = [];
    for (const cm of v.matchAll(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([0-9.]+))?\s*\)/gi)) {
      colours.push([+cm[1]!, +cm[2]!, +cm[3]!, cm[4] !== undefined ? parseFloat(cm[4]) : 1]);
    }
    for (const hm of v.matchAll(/#(?:[0-9a-f]{3}|[0-9a-f]{6})\b/gi)) {
      const rgb = parseHex(hm[0]);
      if (rgb) colours.push([rgb[0], rgb[1], rgb[2], 1]);
    }
    let foundGlow = false;
    for (const [r, g, b, a] of colours) {
      // ponytail: a warm tinted elevation (60,40,20 — channel spread 40) was
      // reported as "neon glow". Glow needs real chroma, not any non-gray.
      const greyish = Math.max(r, g, b) - Math.min(r, g, b) < 60;
      if (!greyish && a >= 0.3) { foundGlow = true; break; }
    }
    if (foundGlow) {
      tells.push("neon glow (coloured large-blur box-shadow) — v0/Cursor signature");
      break;
    }
  }

  // 4. The default card — untouched shadcn reflex. Require rounded-2xl/3xl AND
  //    shadow-lg/xl AND p-6/p-8 to co-occur (the actual slop reflex).
  if (/(rounded-(2xl|3xl))/.test(lower) && /(shadow-(lg|xl))/.test(lower) && /\bp-(6|8)\b/.test(lower)) {
    tells.push("default card (rounded-2xl + shadow-lg + p-6 reflex) — separate with whitespace → bg shift → elevation first");
  }

  // 5. 1px gray card border — the most reliable single AI tell. Tailwind
  //    border-zinc/gray defaults OR a literal 1px solid near-gray hex.
  const tailwindGray = /\bborder-(zinc|gray|slate|neutral)-(?:100|200)\b/.test(lower);
  const litGrayBorder = /border[^;}]*:\s*1px\s+solid\s+(#(?:e5e7eb|e4e4e7|d4d4d8|f1f5f9|e2e8f0))\b/i.test(stripped);
  if (tailwindGray || litGrayBorder) {
    tells.push("1px gray card border (border-zinc/gray default or near-gray 1px solid) — the most reliable AI tell");
  }

  // 6. Eyebrow labels — tracked-out ALL-CAPS micro-labels above headings are
  //    template chrome (anthropics/skills frontend-design). Conservative: only
  //    flag when text-transform: uppercase, font-size ≤13px AND wide tracking
  //    (letter-spacing ≥ 0.08em) co-occur in the same block — the "tracked-out"
  //    part is the slop signature; plain uppercase labels with normal tracking
  //    are a legitimate table/label style.
  const ruleRe = /([^{}]+)\{([^}]*)\}/g;
  ruleRe.lastIndex = 0;
  let rm2: RegExpExecArray | null;
  while ((rm2 = ruleRe.exec(stripped)) !== null) {
    const decls = (rm2[2] ?? "").toLowerCase();
    if (!/text-transform\s*:\s*uppercase/.test(decls)) continue;
    const fs = decls.match(/font-size\s*:\s*([0-9.]+)(px|rem|em|pt)/);
    if (!fs || !fs[1] || !fs[2]) continue;
    const px = parseFloat(fs[1]) * (PX_PER_UNIT[fs[2]] ?? 1);
    if (px > 13) continue;
    const ls = decls.match(/letter-spacing\s*:\s*([0-9.]+)(px|rem|em)/);
    // Threshold is documented in em (≥0.08em) and em scales with the element's
    // OWN font-size — so normalise every unit to em before comparing.
    const lsEm = ls && ls[1] && ls[2]
      ? parseFloat(ls[1]) * (ls[2] === "em" ? 1 : ls[2] === "rem" ? 16 / px : 1 / px)
      : 0;
    if (lsEm >= 0.08) {
      tells.push("eyebrow label (tracked-out uppercase at ≤13px, letter-spacing ≥0.08em) — template chrome; try sentence-case micro-labels or weight/colour instead");
      break;
    }
  }

  // 7. Tinted near-black backgrounds — #0B0B0B/#111 standing in for black is
  //    template chrome. Flag background hex where every channel ≤ 0x14 and the
  //    channel spread ≤ 3 (a near-neutral tint, not a real colour); pure #000
  //    is a deliberate choice and stays allowed. colour: declarations are
  //    exempt — near-black copy text is fine.
  const bgRe = /background(?:-color)?\s*:\s*[^;}]*#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})(?![0-9a-f])/gi;
  bgRe.lastIndex = 0;
  let bm: RegExpExecArray | null;
  while ((bm = bgRe.exec(stripped)) !== null) {
    const rgb = parseHex("#" + bm[1]);
    if (!rgb) continue;
    const max = Math.max(rgb[0], rgb[1], rgb[2]);
    const spread = max - Math.min(rgb[0], rgb[1], rgb[2]);
    if (max > 0 && max <= 0x14 && spread <= 3) {
      tells.push("tinted near-black background (#0B0B0B/#111 standing in for black) — template chrome tell");
      break;
    }
  }

  return { tells };
}

// Contrast pairs auto-extracted from rules that declare both a colour and a
// background. Var() references resolve through the :root token map. Blocks
// without an explicit background are skipped — no inherited-bg guessing.
export function extractContrastPairs(css: string): AuditPair[] {
  const nameToValue = collectTokenValues(css);
  const resolve = (value: string): string | null => {
    let v = value.trim();
    // Follow var() chains to a fixed depth — one alias is common, a cycle must
    // stop rather than loop.
    for (let depth = 0; depth < 5; depth++) {
      const varMatch = v.match(/^var\((--[^,)]+)(?:,\s*([^)]*))?\)$/);
      if (!varMatch) break;
      const next = nameToValue.get(varMatch[1] ?? "") || (varMatch[2] ?? "").trim();
      if (next === "" || next === v) return null;
      v = next;
    }
    // A transparent background inherits the ancestor; pairing it with black
    // invented a failing pair on every ghost/outline button.
    if (/^transparent$/i.test(v) || parseAlpha(v) === 0) return null;
    if (parseColor(v) !== null) return v;
    // ponytail: layered background values (e.g. "url(x.png) #fff") — pair with
    // the first space-separated token the parsers accept, not just token 0.
    if (/\s/.test(v)) {
      for (const token of v.split(/\s+/)) {
        if (parseColor(token) !== null) return token;
      }
    }
    return null;
  };

  const pairs: AuditPair[] = [];
  const seen = new Set<string>();
  const ruleRe = /([^{}]+)\{([^}]*)\}/g;
  ruleRe.lastIndex = 0;
  let rm: RegExpExecArray | null;
  while ((rm = ruleRe.exec(css)) !== null && pairs.length < 24) {
    const decls = rm[2] ?? "";
    const colorMatch = decls.match(/(?:^|;)\s*color\s*:\s*([^;]+)/);
    const bgMatch = decls.match(/(?:^|;)\s*(?:background|background-color)\s*:\s*([^;]+)/);
    if (!colorMatch || !bgMatch || !colorMatch[1] || !bgMatch[1]) continue;
    const fg = resolve(colorMatch[1]);
    const bg = resolve(bgMatch[1]);
    // Identical colours are a REAL pair (white on white) — skipping them was
    // the reported vacuous PASS.
    if (!fg || !bg) continue;
    // Normalise to rgb triples so #FFFFFF and #fff dedupe to one pair.
    const keyOf = (c: string) => { const p = parseColor(c); return p ? `${p[0]},${p[1]},${p[2]}` : c.toLowerCase(); };
    const key = keyOf(fg) + "|" + keyOf(bg);
    if (seen.has(key)) continue;
    seen.add(key);
    const selector = (rm[1] ?? "").trim().replace(/\s+/g, " ").slice(0, 40);
    pairs.push({ fg, bg, label: `auto: ${selector}` });
  }
  return pairs;
}

/** Rules that declare both a colour and a background: the contrast gate's scope. */
export function declarablePairCount(css: string): number {
  let count = 0;
  eachRule(css.replace(/\/\*[\s\S]*?\*\//g, " "), ({ decls }) => {
    if (/(?:^|;)\s*color\s*:/.test(decls) && /(?:^|;)\s*(?:background|background-color)\s*:/.test(decls)) count++;
  });
  return count;
}

// --- aggregate gate -------------------------------------------------------

export interface AuditPair {
  fg: string;
  bg: string;
  label?: string;
  min?: number;
  size?: number | string;
  weight?: number | string;
  /** "secondary": captions, metadata, helper text. Needs `size`; see apcaThreshold. */
  role?: "secondary";
}

export interface AuditPairResult extends AuditPair {
  apca: number | null;
  apcaMin: number;
  ratio: number | null;
  pass: boolean;
  /** Set when the foreground alpha was composited over the declared background. */
  effectiveFg?: string;
}

export type GateStatus = "pass" | "fail" | "incomplete";

export interface AuditResult {
  autoPairs: boolean;
  gates: {
    status: GateStatus;
    contrast: { pass: boolean; status: GateStatus; pairsChecked: number; declarablePairs: number; results: AuditPairResult[] };
    tokens: { pass: boolean; status: GateStatus; hardcodedHex: string[]; adhocShadow: string[]; hexUses: Array<{ selector: string; value: string }> };
    states: StateFindings & { pass: boolean; status: GateStatus };
    slopTells: { pass: boolean; status: GateStatus; tells: string[] };
  };
  pass: boolean;
}

/** Alpha-composite the foreground over the declared background before judging. */
function compositeOver(fg: string, bg: string): { color: string; composited: boolean } {
  const alpha = parseAlpha(fg);
  const fgRgb = parseColor(fg);
  const bgRgb = parseColor(bg);
  if (fgRgb === null || bgRgb === null || alpha >= 1) return { color: fg, composited: false };
  const mix = (a: number, b: number) => Math.round(a * alpha + b * (1 - alpha));
  return { color: `rgb(${mix(fgRgb[0], bgRgb[0])},${mix(fgRgb[1], bgRgb[1])},${mix(fgRgb[2], bgRgb[2])})`, composited: true };
}

export function audit({ css = "", pairs = [] }: { css?: string; pairs?: AuditPair[] }): AuditResult {
  const safeCss = typeof css === "string" ? stripCssComments(css) : "";
  let safePairs: AuditPair[] = Array.isArray(pairs) ? pairs : [];
  const tokens = extractTokens(safeCss);
  const off = scanOffSystem(safeCss, tokens);
  const states = scanStates(safeCss);
  const tells = scanSlopTells(safeCss);

  // Silent-gap fix: contrast is only checked for hand-supplied pairs, which
  // callers routinely forget. When none are provided, extract pairs from rules
  // that declare BOTH a colour and a background (resolved via :root tokens).
  // Conservative: no inherited-background guessing.
  let autoPairs = false;
  if (safePairs.length === 0) {
    safePairs = extractContrastPairs(safeCss);
    autoPairs = safePairs.length > 0;
  }

  const contrastResults: AuditPairResult[] = safePairs.map((p) => {
    const composite = compositeOver(p.fg, p.bg);
    const lc = apcaContrastLc(composite.color, p.bg);
    const ratio = contrastRatio(composite.color, p.bg);
    // min: 3 with no size/weight signals a non-text graphic (WCAG 3:1 floor);
    // anything carrying size/weight is copy and uses the text thresholds.
    const isNonText = p.min === 3 && p.size === undefined && p.weight === undefined;
    const apcaMin = apcaThreshold(p.weight, p.size, isNonText, p.role);
    // The relaxed APCA bar is only safe with a real floor under it, so secondary
    // text gets WCAG AA even when the caller passes no `min`.
    const callerMin = typeof p.min === "number" && Number.isFinite(p.min) ? p.min : undefined;
    const wcagMin = callerMin ?? (p.role === "secondary" ? 4.5 : undefined);
    // pass follows APCA (primary) AND honours `min` as the WCAG floor — the
    // reported defect was a `min` field that did nothing.
    let pass: boolean;
    if (lc === null) {
      pass = ratio === null ? false : ratio >= (wcagMin ?? 4.5);
    } else {
      pass = Math.abs(lc) >= apcaMin && (wcagMin === undefined || (ratio !== null && ratio >= wcagMin));
    }
    return {
      ...p,
      ...(wcagMin === undefined ? {} : { min: wcagMin }),
      apca: lc === null ? null : Math.round(lc * 100) / 100,
      apcaMin,
      ratio: ratio === null ? null : Math.round(ratio * 100) / 100,
      pass,
      ...(composite.composited ? { effectiveFg: composite.color } : {}),
    };
  });

  const contrastPass = contrastResults.every((r) => r.pass);
  const tokensPass = off.hardcodedHex.length === 0 && off.adhocShadow.length === 0;
  const statesPass = states.missingFocusVisible.length === 0 && states.missingDisabled.length === 0 && states.missingReducedMotion.length === 0 && states.focusRingKills.length === 0;
  const tellsPass = tells.tells.length === 0;

  const statusOf = (findings: number, scanned: boolean): GateStatus => (findings > 0 ? "fail" : scanned ? "pass" : "incomplete");
  const hasCss = safeCss.trim() !== "";
  const contrastStatus = statusOf(contrastResults.filter((r) => !r.pass).length, contrastResults.length > 0);
  const tokensStatus = statusOf(off.hardcodedHex.length + off.adhocShadow.length, hasCss);
  const statesStatus = statusOf(states.missingFocusVisible.length + states.missingDisabled.length + states.missingReducedMotion.length + states.focusRingKills.length, hasCss && (states.hasInteractive || states.hasMotion));
  const tellsStatus = statusOf(tells.tells.length, hasCss);
  const statuses = [contrastStatus, tokensStatus, statesStatus, tellsStatus];
  const overall: GateStatus = statuses.includes("fail") ? "fail" : statuses.includes("incomplete") ? "incomplete" : "pass";

  return {
    autoPairs,
    gates: {
      status: overall,
      contrast: {
        pass: contrastPass,
        status: contrastStatus,
        pairsChecked: contrastResults.length,
        declarablePairs: declarablePairCount(safeCss),
        results: contrastResults,
      },
      tokens: { pass: tokensPass, status: tokensStatus, ...off },
      states: { pass: statesPass, status: statesStatus, ...states },
      slopTells: { pass: tellsPass, status: tellsStatus, ...tells },
    },
    pass: contrastPass && tokensPass && statesPass && tellsPass,
  };
}
