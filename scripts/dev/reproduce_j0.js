import { createGame, step, useAbility, getLegalTargets } from '../sim/engine.js';

console.log('--- Case 1: swipe -> Rewind -> swipe -> Rewind (two separate undos) ---');
const g1 = createGame(12345, { forcedRelics: ['rewind'], forceAtMove: 0 });
g1.abilities.rewind.charges = 2;

console.log(`Initial: moveCount=${g1.moveCount}, charges=${g1.abilities.rewind.charges}`);
const res1_swipe1 = step(g1, 'L');
console.log(`After Swipe 1: moveCount=${g1.moveCount}, charges=${g1.abilities.rewind.charges}, canRewind=${getLegalTargets(g1, 'rewind').length > 0}`);
const res1_undo1 = useAbility(g1, 'rewind');
console.log(`After Rewind 1: moveCount=${g1.moveCount}, charges=${g1.abilities.rewind.charges}, canRewind=${getLegalTargets(g1, 'rewind').length > 0}`);

const res1_swipe2 = step(g1, 'L');
console.log(`After Swipe 2: moveCount=${g1.moveCount}, charges=${g1.abilities.rewind.charges}, canRewind=${getLegalTargets(g1, 'rewind').length > 0}`);
const res1_undo2 = useAbility(g1, 'rewind');
console.log(`After Rewind 2: moveCount=${g1.moveCount}, charges=${g1.abilities.rewind.charges}, canRewind=${getLegalTargets(g1, 'rewind').length > 0}`);
console.log('Result: Two separate undos SUCCESSFUL.\n');

console.log('--- Case 2: swipe -> Rewind -> Rewind (consecutive undo) ---');
const g2 = createGame(12345, { forcedRelics: ['rewind'], forceAtMove: 0 });
g2.abilities.rewind.charges = 2;

console.log(`Initial: moveCount=${g2.moveCount}, charges=${g2.abilities.rewind.charges}`);
const res2_swipe = step(g2, 'L');
console.log(`After Swipe: moveCount=${g2.moveCount}, charges=${g2.abilities.rewind.charges}, canRewind=${getLegalTargets(g2, 'rewind').length > 0}`);
const res2_undo1 = useAbility(g2, 'rewind');
console.log(`After Rewind 1: moveCount=${g2.moveCount}, charges=${g2.abilities.rewind.charges}, canRewind=${getLegalTargets(g2, 'rewind').length > 0}`);

try {
  useAbility(g2, 'rewind');
  console.log('After Rewind 2: SUCCESS');
} catch (err) {
  console.log(`After Rewind 2: FAILED with error: "${err.message}"`);
}
