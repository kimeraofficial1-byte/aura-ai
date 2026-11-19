const CRISIS_MEMORY_PATTERNS: RegExp[] = [
  /(suicid|ammazz|uccidermi|farla finita|autolesion|non voglio (?:piu )?vivere)/i,
  /(voglio morire|preferirei morire|togliermi la vita|togliere la vita|tagliarmi|faccio del male|farmi del male)/i,
  /(non ce la faccio piu a vivere|meglio se sparissi|non ha senso vivere)/i,
  /(pronto soccorso|numero di emergenza|\b112\b|\b118\b)/i,
];

const CLINICAL_HEALTH_PATTERNS: RegExp[] = [
  /\b(diagnosi|diagnosticat[oa]|patologia|disturbo bipolare|depressione maggiore|schizofreni|borderline|ocd|doc|ptsd|adhd|autismo)\b/i,
  /\b(psichiatr[aoi]?|psicofarmac[oi]?|antidepressiv[oi]?|ansiolitic[oi]?|benzodiazepin[ae]?|stabilizzatore dell'umore|terapia farmacologica|ricetta medica|dosaggio|milligrammi|\bmg\b)\b/i,
  /\b(xanax|tavor|lexotan|prozac|zoloft|sertralina|fluoxetina|alprazolam|lorazepam|citalopram|escitalopram|paroxetina|diazepam|valium|litio)\b/i,
  /\b(esame del sangue|referto|biopsia|tac|risonanza magnetica|ricovero|cartella clinica)\b/i,
];

const SENSITIVE_PII_PATTERNS: RegExp[] = [
  /[A-Z]{6}\d{2}[A-Z]\d{2}[A-Z]\d{3}[A-Z]/i, // Codice fiscale italiano
  /\bIT\d{2}[A-Z]\d{10}[0-9A-Z]{12}\b/i, // IBAN italiano
  /\b(password|pin bancario|numero carta|carta di credito)\b/i,
];

export function normalizeText(input: string): string {
  return input
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

export function isCrisisOrClinicalContent(text: string): boolean {
  const normalized = normalizeText(text);
  if (!normalized) return false;
  return (
    CRISIS_MEMORY_PATTERNS.some((re) => re.test(normalized)) ||
    CLINICAL_HEALTH_PATTERNS.some((re) => re.test(normalized)) ||
    SENSITIVE_PII_PATTERNS.some((re) => re.test(normalized))
  );
}

export function redactSensitiveTokens(text: string): string {
  return text
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[email rimossa]")
    .replace(/\b(?:\+?\d[\d\s-]{7,}\d)\b/g, "[numero rimosso]")
    .replace(/\s+/g, " ")
    .trim();
}

export function isSafeForLongTermMemory(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (isCrisisOrClinicalContent(trimmed)) return false;
  return true;
}
