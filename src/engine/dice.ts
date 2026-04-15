function d(n: number): number {
  return Math.floor(Math.random() * n) + 1;
}

/** Roll n dice of size `sides`, return sorted rolls and total */
export function rollDice(count: number, sides: number): { rolls: number[]; min: number; max: number } {
  const rolls: number[] = [];
  for (let i = 0; i < count; i++) rolls.push(d(sides));
  rolls.sort((a, b) => a - b);
  return { rolls, min: rolls[0]!, max: rolls[rolls.length - 1]! };
}

/**
 * NattBorg-style ability: lesser of 2d6 minus lesser of 2d4 (rolled fresh for each score).
 */
export function rollNattBorgAbility(statName: string): { value: number; detail: string } {
  const a = rollDice(2, 4);
  const b = rollDice(2, 6);
  const low4 = a.min;
  const low6 = b.min;
  const value = low6 - low4;
  const detail = `${statName}: min(2d4)=[${a.rolls.join(",")}]→${low4}; min(2d6)=[${b.rolls.join(",")}]→${low6}; ${low6}−${low4}=${value}`;
  return { value, detail };
}
