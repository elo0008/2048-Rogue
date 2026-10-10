/**
 * Relic definitions for 2048-Rogue.
 * 8 total relics as specified in the rules.
 */

export const RELIC_IDS = [
  'triple_threat',
  'fault_line',
  'pressure_cooker',
  'diagonal_merge',
  'mason',
  'anchor_row',
  'foresight',
  'gravity_well',
  'siphon',
  'shatter',
  'last_stand',
  'diagonal_charge',
  'eraser',
  'rewind',
];

export const RELICS = {
  triple_threat: {
    id: 'triple_threat',
    name: 'Triple Threat',
    description: 'During a slide, 3 equal adjacent tiles merge into one tile of 4x value.'
  },
  fault_line: {
    id: 'fault_line',
    name: 'Fault Line',
    description: 'Before slide, stones shift 1 cell in slide direction if cell beyond is empty and cell behind has a number tile.'
  },
  pressure_cooker: {
    id: 'pressure_cooker',
    name: 'Pressure Cooker',
    description: 'Stone interval reduced by 30% (min 3). Each merge awards +2 bonus score.'
  },
  diagonal_merge: {
    id: 'diagonal_merge',
    name: 'Diagonal Merge',
    description: 'Post-slide: merge 1 diagonally adjacent equal pair (highest value first, ties broken by row-major).'
  },
  mason: {
    id: 'mason',
    name: 'Mason',
    description: 'When a stone spawns, bot chooses between 2 random empty cells.'
  },
  anchor_row: {
    id: 'anchor_row',
    name: 'Anchor Row',
    description: 'Anchored line is fixed. Sliding along: line cannot move or merge. Sliding perpendicular: acts as barrier and receiver.'
  },
  foresight: {
    id: 'foresight',
    name: 'Foresight',
    description: 'See the values of the next 2 tile spawns and when a stone is due.'
  },
  gravity_well: {
    id: 'gravity_well',
    name: 'Gravity Well',
    description: 'Tile spawns favor empty cells in the 8-neighborhood of the highest-value tile.'
  },
  siphon: {
    id: 'siphon',
    name: 'Siphon',
    description: 'If any merge in this move slide phase (diagonal included) created a tile >= siphonMin (default 16), skip tile spawn. Stone spawn unaffected. Max one skip per move.'
  },
  shatter: {
    id: 'shatter',
    name: 'Shatter',
    description: 'After slide phase, remove stones orthogonally adjacent to any tile created by a merge with value >= shatterMin (default 64).'
  },
  last_stand: {
    id: 'last_stand',
    name: 'Last Stand',
    description: 'Once per run, on no-valid-slide, remove tiles <= lastStandMax (default 16) and retry. If still stuck, game over.'
  },
  diagonal_charge: {
    id: 'diagonal_charge',
    name: 'Diagonal Merge',
    description: 'Charge: merge two equal tiles touching diagonally (you pick). Holds up to {max}; +1 every {N} moves. Costs no move.'
  },
  eraser: {
    id: 'eraser',
    name: 'Eraser',
    description: 'Charge: remove any one tile. Holds up to {max}; +1 every {N} moves. Costs no move.'
  },
  rewind: {
    id: 'rewind',
    name: 'Rewind',
    description: 'Charge: undo your last swipe. Holds up to {max}; +1 every {N} moves. Costs no move.'
  },
};
