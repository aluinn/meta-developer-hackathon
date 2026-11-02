// Remembers the character the player made (as a small PNG, in this browser only) and finds the picture to use in play mode.

const KEY = 'roomworld.character'
export const DEFAULT_CHARACTER_URL = '/assets/character.png' // the original bean (web/public/assets), made with Muse Image

/** The player's own character as a data: URL, or null. Storage can be blocked (private windows), so every call is guarded. */
export function getCustomCharacter(): string | null {
  try {
    const value = localStorage.getItem(KEY)
    return value && value.startsWith('data:image/png;base64,') ? value : null
  } catch {
    return null
  }
}

export function saveCustomCharacter(dataUrl: string): void {
  try {
    localStorage.setItem(KEY, dataUrl)
  } catch {
    // storage full or blocked: the character just won't be remembered
  }
}

export function clearCustomCharacter(): void {
  try {
    localStorage.removeItem(KEY)
  } catch {
    // nothing to do
  }
}

/** Where play mode should load the character picture from. */
export function characterPictureUrl(): string {
  return getCustomCharacter() ?? DEFAULT_CHARACTER_URL
}
