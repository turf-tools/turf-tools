// Canonical form used for user lookup + uniqueness. Lowercased + trimmed
// always; for @gmail.com / @googlemail.com addresses, dots are stripped
// from the local part *before* the first `+` so plus-addressing is
// preserved as a way to distinguish accounts (e.g. for testing).
// `googlemail.com` is aliased to `gmail.com` — same inbox either way.
export function normalizeEmail(input: string): string {
  const trimmed = input.trim().toLowerCase();
  const at = trimmed.lastIndexOf("@");
  if (at < 0) return trimmed;
  const local = trimmed.slice(0, at);
  let domain = trimmed.slice(at + 1);
  if (domain === "googlemail.com") domain = "gmail.com";
  if (domain !== "gmail.com") return `${local}@${domain}`;
  const plusIdx = local.indexOf("+");
  const beforePlus = plusIdx >= 0 ? local.slice(0, plusIdx) : local;
  const afterPlus = plusIdx >= 0 ? local.slice(plusIdx) : "";
  return `${beforePlus.replace(/\./g, "")}${afterPlus}@${domain}`;
}
