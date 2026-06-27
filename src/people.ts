// Maps a GitHub login to the person's first name as used in SaplingLearn/sapling's
// ROADMAP.md (the Team & Responsibilities table and the per-person sprint bullets).
// Hardcoded for the small, stable team; an unmapped login simply gets no roadmap section.
export const LOGIN_TO_PERSON: Record<string, string> = {
  AndresL230: "Andres",
  "Jose-Gael-Cruz-Lopez": "Jose",
  "lpcooper-arch": "Luke",
  "Darkest-Teddy": "Jack",
};

export function loginToPerson(login: string): string | null {
  return LOGIN_TO_PERSON[login] ?? null;
}
