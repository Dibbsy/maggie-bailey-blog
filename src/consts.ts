// Place any global data in this file.
// You can import this data from anywhere in your site by using the `import` keyword.

export const SITE_TITLE = "Maggie & Bailey";
export const SITE_DESCRIPTION =
  "Life with Mum and Dad, told by the two dogs who actually run the house.";

export const AUTHORS = {
  maggie: { name: "Maggie", emoji: "🎾" },
  bailey: { name: "Bailey", emoji: "💨" },
  both: { name: "Maggie & Bailey", emoji: "🐾" },
} as const;
export type AuthorKey = keyof typeof AUTHORS;
