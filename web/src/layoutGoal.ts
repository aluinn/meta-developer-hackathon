// THE LAYOUT GOAL: what the person wants done to the room, in words (spoken or typed),
// e.g. "make room for a wheelchair". It lives here and nowhere else.
//
// Z4 (clearance check) and Z6 (before/after) read it with getLayoutGoal(), and can react
// to changes with onLayoutGoalChange(). The Layout panel writes it with setLayoutGoal().

let goal = ''
const listeners = new Set<(goal: string) => void>()

export function getLayoutGoal(): string {
  return goal
}

export function setLayoutGoal(text: string): void {
  goal = text.trim()
  for (const listener of listeners) listener(goal)
}

/** Call `listener` whenever the goal changes. Returns a function that stops listening. */
export function onLayoutGoalChange(listener: (goal: string) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
