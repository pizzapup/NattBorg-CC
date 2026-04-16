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
