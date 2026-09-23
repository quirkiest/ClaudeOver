'use strict';
/**
 * screen.js v0.2.4 - the ClaudeOver "home" screen shown on Jibo while Claude
 * mode is on. Served by the gateway at GET /screen.svg and displayed with
 * rom-control display.showImage(url) (TAKEOVER_SCREEN=image).
 *
 * Why an image: display.showText() is a single-line label with no wrapping, so
 * the instructions ran off both edges of the screen.
 *
 * Jibo's screen is 1280x720 behind a circular bezel: keep content inside the
 * centre ~900x520 so nothing is clipped at the corners.
 * Colours match the menu tile / skill panel (Claude orange on warm dark).
 */

function esc (s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * @param {{version: string, state?: string}} o
 * @returns {string} SVG document
 */
function homeSvg (o) {
  const v = esc(o.version);
  const rows = [
    ['Ask', '“Hey Jibo”, then your question'],
    ['Exit', 'Pat my head twice, or hold it'],
    ['', 'or swipe down, or say “Claude off”'],
  ];
  const lines = rows.map((r, i) => {
    const y = 380 + i * 64;
    return (r[0] ? `<text x="250" y="${y}" class="k">${esc(r[0])}</text>` : '') +
      `<text x="390" y="${y}" class="t">${esc(r[1])}</text>`;
  }).join('\n  ');

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">
  <style>
    .h { font: bold 84px sans-serif; fill: #E0896B; }
    .s { font: 34px sans-serif; fill: #F3ECE4; }
    .k { font: bold 36px sans-serif; fill: #E0896B; }
    .t { font: 36px sans-serif; fill: #F3ECE4; }
    .v { font: 26px sans-serif; fill: #9A8F84; }
  </style>
  <rect width="1280" height="720" fill="#1A1512"/>
  <circle cx="240" cy="205" r="34" fill="#D97757"/>
  <path d="M222 190h36a8 8 0 0 1 8 8v16a8 8 0 0 1-8 8h-20l-12 10v-10h-4a8 8 0 0 1-8-8v-16a8 8 0 0 1 8-8z" fill="#1A1512"/>
  <text x="300" y="235" class="h">ClaudeOver</text>
  <text x="302" y="285" class="s">Claude mode is on</text>
  <line x1="250" y1="318" x2="1030" y2="318" stroke="#4A3C33" stroke-width="2"/>
  ${lines}
  <text x="1030" y="610" class="v" text-anchor="end">gateway v${v}</text>
</svg>
`;
}

/** Short single-line fallback for display.showText (TAKEOVER_SCREEN=text). */
function homeText (version) {
  return 'ClaudeOver  ·  v' + version;
}

module.exports = { homeSvg, homeText };
