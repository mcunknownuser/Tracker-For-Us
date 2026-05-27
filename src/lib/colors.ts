// =============================================================================
//  colors.ts
//  Curated palette for category / payment-method swatches.
//
//  The brief:
//    - Luxurious, editorial feel (think Vogue, Vanity Fair, Cereal magazine)
//    - Neutral enough not to scream against the dark UI
//    - Distinct enough to pop against neutral-950 backgrounds
//    - No bright primaries (no Bootstrap red/blue/green)
// =============================================================================

export const LUXE_PALETTE = [
  // Row 1 — warm + mid-tone luxe accents
  '#c8a14a', // Champagne gold
  '#b07054', // Terracotta clay
  '#8b3d4f', // Burgundy
  '#6f5378', // Dusty plum
  '#3a6873', // Muted teal
  '#3d6354', // Forest
  '#5a6473', // Slate
  '#d4c4a0', // Warm cream

  // Row 2 — dark, atmospheric luxe (couture, library wood, deep velvet)
  '#5a2532', // Deep oxblood
  '#243250', // Midnight blue
  '#4a3528', // Espresso
  '#3e2842', // Dark eggplant
  '#234032', // Pine
  '#3a3d45', // Dark slate
  '#7a5526', // Antique bronze
  '#553028', // Mahogany
] as const;

export type LuxeColor = (typeof LUXE_PALETTE)[number];

export const DEFAULT_LUXE_COLOR: LuxeColor = LUXE_PALETTE[0];
