// A little animation of a pencil drawing a character, shown while the real picture is being made.
// The drawing is plain SVG (our own, nothing downloaded) and the movement is CSS in style.css.

/** A box with the animated drawing in it. Hide or show it with the `hidden` attribute. */
export function createSketch(): HTMLElement {
  const box = document.createElement('div')
  box.className = 'character-sketch'
  box.setAttribute('role', 'img')
  box.setAttribute('aria-label', 'A pencil drawing your character')
  box.innerHTML = `<svg viewBox="0 0 200 240" aria-hidden="true">
  <path class="sk-fill sk-fill-body" d="M100 40 C60 40 45 90 48 140 C50 190 75 215 100 215 C125 215 150 190 152 140 C155 90 140 40 100 40 Z"/>
  <path class="sk-fill sk-fill-leaf" d="M100 40 C100 22 112 14 126 14 C124 28 114 38 100 40"/>
  <path class="sk-line sk-body" pathLength="1" d="M100 40 C60 40 45 90 48 140 C50 190 75 215 100 215 C125 215 150 190 152 140 C155 90 140 40 100 40 Z"/>
  <path class="sk-line sk-leaf" pathLength="1" d="M100 40 C100 22 112 14 126 14 C124 28 114 38 100 40"/>
  <path class="sk-line sk-eyel" pathLength="1" d="M82 105 a7 7 0 1 0 14 0 a7 7 0 1 0 -14 0"/>
  <path class="sk-line sk-eyer" pathLength="1" d="M104 105 a7 7 0 1 0 14 0 a7 7 0 1 0 -14 0"/>
  <path class="sk-line sk-smile" pathLength="1" d="M88 130 Q100 142 112 130"/>
  <path class="sk-line sk-arml" pathLength="1" d="M50 135 Q30 138 26 152"/>
  <path class="sk-line sk-armr" pathLength="1" d="M150 135 Q170 138 174 152"/>
  <path class="sk-line sk-footl" pathLength="1" d="M78 214 Q74 228 62 226"/>
  <path class="sk-line sk-footr" pathLength="1" d="M122 214 Q126 228 138 226"/>
  <g class="sk-pencil">
    <path d="M0 0 L5 -9 L40 -44 L48 -36 L13 -2 Z" fill="#f5b83d" stroke="#3a2a14" stroke-width="1.5" stroke-linejoin="round"/>
    <path d="M0 0 L5 -9 L13 -2 Z" fill="#e8c9a0" stroke="#3a2a14" stroke-width="1.5" stroke-linejoin="round"/>
    <path d="M40 -44 L48 -36 L53 -41 L45 -49 Z" fill="#e57b8e" stroke="#3a2a14" stroke-width="1.5" stroke-linejoin="round"/>
  </g>
</svg>` // fixed markup we wrote ourselves, no user text in it
  return box
}
